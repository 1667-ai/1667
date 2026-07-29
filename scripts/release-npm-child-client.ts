import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../server/canonical-json.js";
import {
  NpmProcessJournal,
  type NpmProcessToolIdentity
} from "./release-npm-process-journal.js";
import {
  NpmChildCallbackLifecycle,
  NpmChildStateUncertainError,
  type NpmChildUncertaintyTransition
} from "./release-npm-child-lifecycle.js";

export { NpmChildStateUncertainError } from
  "./release-npm-child-lifecycle.js";

const MAX_TOOL_BYTES = 256 * 1024 * 1024;
const DEFAULT_INDEPENDENT_TIMEOUT_MS = 5 * 60_000;
const RUNNER = fileURLToPath(
  new URL("./release-npm-child-runner.mjs", import.meta.url)
);

export interface NpmChildClientOptions {
  readonly nodeExecutable: string;
  readonly npmCli: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly journal: NpmProcessJournal;
  readonly writeTimeoutMs: number;
  readonly terminationGraceMs: number;
  readonly independentTimeoutMs?: number;
}

export interface NpmCommandRunner {
  run(arguments_: readonly string[]): Promise<void>;
}

export class NpmChildClient implements NpmCommandRunner {
  readonly #nodeExecutable: string;
  readonly #npmCli: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #journal: NpmProcessJournal;
  readonly #writeTimeoutMs: number;
  readonly #terminationGraceMs: number;
  readonly #independentTimeoutMs: number;
  readonly #tool: NpmProcessToolIdentity;
  #uncertainCause: Error | null = null;

  constructor(options: NpmChildClientOptions) {
    this.#nodeExecutable = boundedTool(
      options.nodeExecutable,
      true,
      "Release Node executable"
    );
    this.#npmCli = boundedTool(options.npmCli, false, "Release npm CLI");
    const runner = boundedTool(RUNNER, false, "Release npm child runner");
    this.#environment = { ...options.environment };
    this.#journal = options.journal;
    this.#writeTimeoutMs = duration(options.writeTimeoutMs, 10 * 60_000);
    this.#terminationGraceMs = duration(options.terminationGraceMs, 30_000);
    this.#independentTimeoutMs = duration(
      options.independentTimeoutMs ?? DEFAULT_INDEPENDENT_TIMEOUT_MS,
      DEFAULT_INDEPENDENT_TIMEOUT_MS
    );
    this.#tool = Object.freeze({
      node: toolIdentity(this.#nodeExecutable),
      npmCli: toolIdentity(this.#npmCli),
      runner: toolIdentity(runner)
    });
  }

  async run(arguments_: readonly string[]): Promise<void> {
    if (this.#uncertainCause !== null) {
      throw new NpmChildStateUncertainError(
        "npm child state is uncertain; this client refuses another write",
        { cause: this.#uncertainCause }
      );
    }
    const nonce = randomBytes(32).toString("hex");
    const args = Object.freeze([...arguments_]);
    const npmCommand = Object.freeze([
      this.#nodeExecutable,
      this.#npmCli,
      `--user-agent=1667-npm-operation-${nonce}`,
      ...args
    ]);
    const config = {
      nonce,
      journalPath: this.#journal.path,
      identity: this.#journal.identity,
      tool: this.#tool,
      arguments: args,
      npmCommand,
      independentTimeoutMs: this.#independentTimeoutMs,
      terminationGraceMs: this.#terminationGraceMs
    };
    const encoded = Buffer.from(canonicalJson(config), "utf8").toString("base64url");
    await this.#execute(encoded, nonce, args, npmCommand);
  }

  async #execute(
    config: string,
    nonce: string,
    arguments_: readonly string[],
    npmCommand: readonly string[]
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const supervisor = spawn(
        this.#nodeExecutable,
        [this.#tool.runner.path, "supervise", config],
        {
          detached: true,
          env: this.#environment,
          shell: false,
          stdio: ["inherit", "inherit", "inherit", "ipc"],
          windowsHide: true
        }
      );
      const processGroupId = supervisor.pid;
      const lifecycle = new NpmChildCallbackLifecycle();
      let writeDeadline: ReturnType<typeof setTimeout> | undefined;
      let terminalResult: {
        readonly outcome: "success" | "failed" | "timed-out";
        readonly signal: NodeJS.Signals | null;
        readonly code: number | null;
        readonly runnerError: Error | undefined;
      } | null = null;
      let keeperSettled = false;
      const startWriteDeadline = (): void => {
        lifecycle.writeDeadlineStarted();
        writeDeadline = setTimeout(() => {
          try {
            if (supervisor.connected) {
              supervisor.send({ type: "cancel", nonce, reason: "timeout" });
            }
          } catch (error) {
            beginUncertainFailure(error);
          }
        }, this.#writeTimeoutMs);
      };
      const clearWriteDeadline = (): void => {
        if (writeDeadline !== undefined) clearTimeout(writeDeadline);
        writeDeadline = undefined;
      };
      supervisor.on("message", (value) => {
        try {
          const message = ipcMessage(value, nonce);
          if (message.type === "ready") {
            const pid = lifecycle.ready(message.pid);
            this.#journal.started({
              pid,
              nonce,
              tool: this.#tool,
              arguments: arguments_,
              npmCommand
            });
            startWriteDeadline();
            supervisor.send({ type: "permit", nonce }, (error) => {
              if (error !== null) beginUncertainFailure(error);
            });
          } else if (message.type === "runner-error") {
            lifecycle.runnerFailed(new Error(
              typeof message.message === "string"
                ? message.message
                : "npm child runner failed"
            ));
          } else if (message.type === "exit") {
            const terminal = lifecycle.terminal(message.pid);
            clearWriteDeadline();
            const code = nullableExitCode(message.code);
            const signal = nullableSignal(message.signal);
            const outcome = message.timedOut === true
              ? "timed-out"
              : code === 0 && signal === null
                ? "success"
                : "failed";
            this.#journal.terminal({
              pid: terminal.pid,
              nonce,
              outcome,
              code,
              signal
            });
            lifecycle.terminalRecorded();
            terminalResult = Object.freeze({
              outcome,
              signal,
              code,
              runnerError: terminal.runnerError
            });
            supervisor.send({
              type: "terminal-recorded",
              pid: terminal.pid,
              nonce
            }, (error) => {
              if (error !== null) beginUncertainFailure(error);
            });
          } else if (message.type === "settled") {
            if (terminalResult === null) {
              throw new Error(
                "npm child keeper settled before its durable terminal record"
              );
            }
            lifecycle.keeperSettled(message.pid);
            keeperSettled = true;
          } else {
            throw new Error("npm child supervisor sent an unknown IPC message");
          }
        } catch (error) {
          beginUncertainFailure(error);
        }
      });
      supervisor.once("error", (error) => {
        clearWriteDeadline();
        const transition = lifecycle.supervisorFailed(error);
        if (transition.kind === "reject-start") {
          reject(transition.error);
        } else if (transition.kind === "terminate") {
          startUncertainTermination(transition.uncertainty);
        }
      });
      supervisor.once("close", () => {
        clearWriteDeadline();
        const uncertainty = lifecycle.supervisorClosed();
        if (uncertainty !== null) {
          startUncertainTermination(uncertainty);
        } else if (keeperSettled && terminalResult !== null) {
          finishTerminal(terminalResult);
        }
      });

      const beginUncertainFailure = (cause: unknown): void => {
        const uncertainty = lifecycle.beginUncertainty(cause);
        if (uncertainty === null) return;
        clearWriteDeadline();
        startUncertainTermination(uncertainty);
      };
      const startUncertainTermination = (
        uncertainty: NpmChildUncertaintyTransition
      ): void => {
        const error = uncertainty.error;
        this.#uncertainCause = error;
        void terminateUncertainChild({
          supervisor,
          nonce,
          processGroupId,
          supervisorClosed: () => lifecycle.isSupervisorClosed(),
          terminationGraceMs: this.#terminationGraceMs
        }).then(() => {
          lifecycle.terminationSettled();
          reject(error);
        }, (terminationError) => {
          lifecycle.terminationSettled();
          reject(new NpmChildStateUncertainError(
            "npm child state is uncertain and termination was not proved",
            { cause: new AggregateError([error, terminationError]) }
          ));
        });
      };
      const finishTerminal = (
        terminal: NonNullable<typeof terminalResult>
      ): void => {
        if (terminal.outcome === "success") {
          resolve();
        } else if (terminal.outcome === "timed-out") {
          reject(new Error(
            "npm tag command exceeded its deadline and was terminated"
          ));
        } else {
          reject(new Error(
            `npm tag command failed with ${
              terminal.signal ?? `exit ${terminal.code ?? "unknown"}`
            }`,
            { cause: terminal.runnerError }
          ));
        }
      };
    });
  }
}

function toolIdentity(file: string): { readonly path: string; readonly sha256: string } {
  return Object.freeze({ path: file, sha256: hashFile(file) });
}

function hashFile(file: string): string {
  const stat = statSync(file);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_TOOL_BYTES) {
    throw new Error(`Release tool is invalid: ${file}`);
  }
  const descriptor = openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const hash = createHash("sha256");
  try {
    let bytes = 0;
    while ((bytes = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

function boundedTool(value: string, executable: boolean, label: string): string {
  if (!path.isAbsolute(value)) throw new Error(`${label} must use an absolute path`);
  const stat = lstatSync(value);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0
    || (executable && (stat.mode & 0o111) === 0)) {
    throw new Error(`${label} must be a usable regular file`);
  }
  return realpathSync(value);
}

function duration(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error("npm child runner duration is invalid");
  }
  return value;
}

function ipcMessage(
  value: unknown,
  nonce: string
): Record<string, unknown> & { type: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("npm child supervisor sent a malformed IPC message");
  }
  const record = value as Record<string, unknown>;
  if (record.nonce !== nonce || typeof record.type !== "string") {
    throw new Error("npm child supervisor IPC identity changed");
  }
  return record as Record<string, unknown> & { type: string };
}

function cancelProtocol(supervisor: ChildProcess, nonce: string): void {
  try {
    if (supervisor.connected) {
      supervisor.send({ type: "cancel", nonce, reason: "protocol" });
    }
  } catch {
    // The keeper timeout terminates the operation process group.
  }
}

async function terminateUncertainChild(options: {
  readonly supervisor: ChildProcess;
  readonly nonce: string;
  readonly processGroupId: number | undefined;
  readonly supervisorClosed: () => boolean;
  readonly terminationGraceMs: number;
}): Promise<void> {
  cancelProtocol(options.supervisor, options.nonce);
  if (options.processGroupId === undefined) {
    throw new Error("npm child process group identity is unavailable");
  }
  const deadline = Date.now() + options.terminationGraceMs + 5_000;
  while (
    (!options.supervisorClosed() || processGroupIsLive(options.processGroupId))
    && Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (
    !options.supervisorClosed()
    || processGroupIsLive(options.processGroupId)
  ) {
    throw new Error("npm child keeper did not terminate its process group");
  }
}

function processGroupIsLive(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

function nullableExitCode(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("npm child supervisor exit code is invalid");
  }
  return value as number;
}

function nullableSignal(value: unknown): NodeJS.Signals | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new Error("npm child supervisor signal is invalid");
  }
  return value as NodeJS.Signals;
}
