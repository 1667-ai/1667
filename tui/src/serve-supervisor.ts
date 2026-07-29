import { spawn, type ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";
import { performance } from "node:perf_hooks";
import {
  HTTP_OPERATION_CANCEL_GRACE_MS
} from "../../shared/http-operation-protocol.js";
import {
  SUPERVISED_SERVE_DESCRIPTOR_CAPACITY,
  decodeChildToSupervisorMessage,
  sameSupervisedOperationDescriptor,
  supervisedOperationKey,
  type ChildToSupervisorMessage,
  type HttpSupervisedOperationDescriptor,
  type SupervisorToChildMessage
} from "../../shared/supervised-serve-protocol.js";
import {
  MAX_CREDENTIAL_NAMES_PER_STATE,
  isCredentialEnvironmentName
} from "../../shared/credential-slot-policy.js";
import {
  MACHINE_TIER_OVERRIDE_VARIABLE
} from "../../shared/machine-tier-environment.js";
import { encodeSupervisedSecrets } from "../../shared/supervised-secret-channel.js";
import {
  assertHttpPlatformSupport
} from "../../server/http-platform-support.js";

interface RetainedDescriptor {
  readonly descriptor: HttpSupervisedOperationDescriptor;
  readonly deadline: number;
}

export const SERVE_HELP = `1667 serve — run a supervised 1667 backend

Usage: 1667 serve [--data <path>] [--port <0-65535>] [--print-logs]

Options:
  --data <path>       Project root to serve, absolute or relative
  --port <number>     Loopback port (default: 0, a free port chosen by the OS)
  --print-logs        Also print unexpected backend errors to stderr
  -h, --help          Show serve help`;

export class ServeUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServeUsageError";
  }
}

export async function runServeSupervisor(argv: readonly string[]): Promise<void> {
  const parsed = parseServeArguments(argv);
  if (parsed === null) return;
  if (process.platform !== "linux" || process.versions.bun === undefined) {
    throw new Error(
      "Supervised serve currently requires a packaged Linux 1667 executable"
    );
  }
  assertHttpPlatformSupport();
  const supervisor = new ServeSupervisor(parsed);
  await supervisor.run();
}

export interface SupervisorArguments {
  readonly dataDir: string | null;
  readonly port: number;
  readonly printLogs: boolean;
}

type SupervisorState = "running" | "settled" | "stopping";

export class ServeSupervisor {
  private readonly descriptors = new Map<string, RetainedDescriptor>();
  private child: ChildProcess | null = null;
  private operationWatchdog: ReturnType<typeof setTimeout> | null = null;
  private shutdownTimer: ReturnType<typeof setTimeout> | null = null;
  private state: SupervisorState = "running";
  private recoveryAttempt = false;
  private secretsSent = false;
  private resolve!: () => void;
  private reject!: (error: unknown) => void;

  constructor(
    private readonly options: SupervisorArguments,
    private readonly spawnProcess: typeof spawn = spawn
  ) {}

  async run(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
      process.once("SIGINT", this.stop);
      process.once("SIGTERM", this.stop);
      this.spawnChild([]);
    }).finally(() => {
      process.off("SIGINT", this.stop);
      process.off("SIGTERM", this.stop);
      this.clearTimers();
    });
  }

  private readonly stop = () => {
    if (this.state !== "running") return;
    this.state = "stopping";
    const child = this.child;
    if (child === null) return this.succeed();
    this.send(child, { type: "shutdown" });
    this.shutdownTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  };

  private spawnChild(recovery: readonly HttpSupervisedOperationDescriptor[]): void {
    const entry = process.argv[1];
    const sourceMode = entry?.endsWith(".ts") === true;
    const args = [
      ...(sourceMode ? [entry!] : []),
      "--supervised-serve-child",
      "--parent-pid",
      String(process.pid),
      "--secret-fd",
      "4",
      "--port",
      String(this.options.port),
      ...(this.options.printLogs ? ["--print-logs"] : []),
      ...(this.options.dataDir === null ? [] : ["--data", this.options.dataDir])
    ];
    const child = this.spawnProcess(process.execPath, args, {
      env: sanitizedSupervisorChildEnvironment(process.env),
      stdio: ["ignore", "inherit", "inherit", "ipc", "pipe"],
      windowsHide: true
    });
    this.child = child;
    this.armOperationWatchdog();
    this.secretsSent = false;
    child.on("message", (value: unknown) => {
      let message: ChildToSupervisorMessage;
      try {
        message = decodeChildToSupervisorMessage(value);
      } catch (error) {
        return this.fail(error);
      }
      this.receive(child, message);
    });
    child.once("error", (error) => {
      if (this.child === child) this.fail(error);
    });
    child.once("spawn", () => {
      this.send(child, { type: "recover", descriptors: recovery });
    });
    child.once("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.shutdownTimer !== null) clearTimeout(this.shutdownTimer);
      this.shutdownTimer = null;
      if (this.state === "settled") return;
      if (this.state === "stopping") {
        if (code === 0 || signal !== null) this.succeed();
        else this.fail(new Error(`Supervised child exited with code ${code}`));
        return;
      }
      if (this.recoveryAttempt) {
        this.fail(new Error(
          `Recovery child exited before readiness (${signal ?? code})`
        ));
        return;
      }
      this.recoveryAttempt = true;
      this.spawnChild([...this.descriptors.values()].map(
        ({ descriptor }) => descriptor
      ));
    });
  }

  private receive(child: ChildProcess, message: ChildToSupervisorMessage): void {
    if (this.child !== child) return;
    switch (message.type) {
      case "secret-request":
        return this.provideSecrets(child, message.names);
      case "secret-ack":
        if (!this.secretsSent) {
          return this.fail(new Error("Child acknowledged secrets before delivery"));
        }
        return;
      case "reserve":
        return this.reserve(child, message.requestId, message.descriptor);
      case "terminal": {
        const key = supervisedOperationKey(message.descriptor);
        const retained = this.descriptors.get(key);
        if (retained === undefined
          || !sameSupervisedOperationDescriptor(
            retained.descriptor,
            message.descriptor
          )) {
          return this.fail(new Error(
            "Child terminal settlement did not match retained authority"
          ));
        }
        this.descriptors.delete(key);
        return this.armOperationWatchdog();
      }
      case "hard-deadline": {
        const key = supervisedOperationKey(message);
        if (!this.descriptors.has(key)) {
          return this.fail(new Error(
            "Child reported a hard deadline for an unknown operation"
          ));
        }
        child.kill("SIGKILL");
        return;
      }
      case "recovered": {
        const expected = new Set(this.descriptors.keys());
        for (const result of message.results) {
          const key = supervisedOperationKey(result);
          if (!expected.delete(key)) {
            return this.fail(new Error("Recovery child returned an unknown operation"));
          }
          this.descriptors.delete(key);
        }
        this.armOperationWatchdog();
        if (expected.size !== 0) {
          return this.fail(new Error("Recovery child omitted retained operations"));
        }
        this.send(child, { type: "activate" });
        return;
      }
      case "ready":
        this.recoveryAttempt = false;
        process.stdout.write(
          `1667 supervised server listening on ${message.origin} `
            + `(data: ${message.dataDir})\n`
        );
        return;
      case "fatal":
        return this.fail(new Error(
          message.diagnosticRef === undefined
            ? message.message
            : `${message.message} (${message.diagnosticRef})`
        ));
    }
  }

  private reserve(
    child: ChildProcess,
    requestId: string,
    descriptor: HttpSupervisedOperationDescriptor
  ): void {
    const key = supervisedOperationKey(descriptor);
    if (requestId !== key) {
      return this.fail(new Error(
        "Child reservation request ID did not match its operation"
      ));
    }
    const accepted = this.descriptors.size < SUPERVISED_SERVE_DESCRIPTOR_CAPACITY
      && !this.descriptors.has(key)
      && Number.isSafeInteger(descriptor.deadlineDelayMs)
      && descriptor.deadlineDelayMs > 0;
    if (accepted) {
      this.descriptors.set(key, {
        descriptor,
        deadline: performance.now() + descriptor.deadlineDelayMs
      });
      this.armOperationWatchdog();
    }
    this.send(child, { type: "reserve-ack", requestId, accepted });
  }

  private armOperationWatchdog(): void {
    if (this.operationWatchdog !== null) clearTimeout(this.operationWatchdog);
    this.operationWatchdog = null;
    if (this.descriptors.size === 0 || this.child === null) return;
    const hardDeadline = Math.min(
      ...[...this.descriptors.values()].map((entry) => entry.deadline)
    ) + HTTP_OPERATION_CANCEL_GRACE_MS;
    this.operationWatchdog = setTimeout(
      () => {
        this.operationWatchdog = null;
        this.child?.kill("SIGKILL");
      },
      Math.max(0, hardDeadline - performance.now())
    );
  }

  private provideSecrets(child: ChildProcess, names: readonly string[]): void {
    if (this.secretsSent
      || names.length > MAX_CREDENTIAL_NAMES_PER_STATE
      || names.some((name) => !isCredentialEnvironmentName(name))
      || names.some((name, index) => index > 0 && names[index - 1]! >= name)) {
      return this.fail(new Error("Child requested invalid credential slots"));
    }
    const values = Object.fromEntries(names.map((name) => [
      name,
      process.env[name] ?? null
    ]));
    let bytes: Buffer;
    try {
      bytes = encodeSupervisedSecrets(values);
    } catch (error) {
      return this.fail(error);
    }
    const channel = child.stdio[4] as Writable | null;
    if (channel === null || channel.writableEnded || channel.destroyed) {
      bytes.fill(0);
      return this.fail(new Error("Child secret channel is unavailable"));
    }
    this.secretsSent = true;
    channel.once("error", (error) => this.fail(error));
    channel.end(bytes, () => {
      bytes.fill(0);
    });
  }

  private send(child: ChildProcess, message: SupervisorToChildMessage): void {
    if (!child.connected) return this.fail(new Error("Child IPC disconnected"));
    child.send(message, (error) => {
      if (error !== null) this.fail(error);
    });
  }

  private fail(error: unknown): void {
    if (this.state === "settled") return;
    this.state = "settled";
    this.child?.kill("SIGKILL");
    this.reject(error);
  }

  private succeed(): void {
    if (this.state === "settled") return;
    this.state = "settled";
    this.resolve();
  }

  private clearTimers(): void {
    if (this.operationWatchdog !== null) clearTimeout(this.operationWatchdog);
    if (this.shutdownTimer !== null) clearTimeout(this.shutdownTimer);
  }
}

export function parseServeArguments(
  argv: readonly string[]
): SupervisorArguments | null {
  let dataDir: string | null = null;
  let port = 0;
  let printLogs = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "serve") continue;
    if (argument === "-h" || argument === "--help") {
      process.stdout.write(`${SERVE_HELP}\n`);
      return null;
    }
    if (argument === "--print-logs") {
      printLogs = true;
      continue;
    }
    if (argument === "--data" || argument === "--port") {
      const value = requiredServeValue(argument, argv[++index]);
      if (argument === "--data") dataDir = value;
      else port = Number(value);
      continue;
    }
    if (argument.startsWith("--data=")) {
      dataDir = requiredServeValue("--data", argument.slice(7));
    } else if (argument.startsWith("--port=")) {
      port = Number(requiredServeValue("--port", argument.slice(7)));
    }
    else throw new ServeUsageError(`unknown serve option: ${argument}`);
  }
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new ServeUsageError("--port must be between 0 and 65535");
  }
  return { dataDir, port, printLogs };
}

function requiredServeValue(
  argument: "--data" | "--port",
  value: string | undefined
): string {
  if (value === undefined || value.trim().length === 0) {
    throw new ServeUsageError(`${argument} requires a value`);
  }
  return value;
}

export function sanitizedSupervisorChildEnvironment(
  source: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const names = [
    "PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM",
    "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME",
    "LOCALAPPDATA", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP",
    MACHINE_TIER_OVERRIDE_VARIABLE
  ];
  return Object.fromEntries(names.flatMap((name) => {
    const value = source[name];
    return value === undefined ? [] : [[name, value]];
  }));
}
