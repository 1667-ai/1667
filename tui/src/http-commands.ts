import { resolve } from "node:path";
import {
  readHttpAuthRecord,
  readHttpAuthRecordFile
} from "../../server/http-auth-record.js";
import {
  startHttpListener,
  type HttpListener
} from "../../server/http-listener.js";
import { validateLegacyServeDataDirectory } from "../../server/legacy-data-directory.js";
import { SingleMutationGate } from "../../server/single-mutation-gate.js";
import { StoryService } from "../../server/story-service.js";
import { runHttpListenerUntilSignal } from "../../server/http-process-lifecycle.js";
import {
  internalErrorReference,
  toPublicServiceError
} from "../../server/service-error-policy.js";
import type { HttpCapabilityScope } from "../../shared/http-auth.js";
import { attachHttpServer } from "./http-attach.js";

export async function runHttpCommand(argv: string[]): Promise<boolean> {
  if (argv[0] === "auth") {
    await runAuthShow(argv.slice(1));
    return true;
  }
  if (argv[0] === "serve") {
    await runLegacyServe(argv.slice(1));
    return true;
  }
  return false;
}

export async function runAuthShow(
  argv: string[],
  output: Pick<NodeJS.WriteStream, "isTTY" | "write"> = process.stdout
): Promise<void> {
  if (argv[0] !== "show") {
    throw new Error("auth requires the show command");
  }
  let scope: HttpCapabilityScope | null = null;
  let authFile: string | null = null;
  let origin: string | null = null;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--scope" || argument === "--auth-file" || argument === "--url") {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${argument} requires a value`);
      if (argument === "--scope") scope = parseScope(value);
      else if (argument === "--auth-file") authFile = resolve(value);
      else origin = value;
    } else if (argument.startsWith("--scope=")) {
      scope = parseScope(requiredInlineValue(argument, "--scope"));
    } else if (argument.startsWith("--auth-file=")) {
      authFile = resolve(requiredInlineValue(argument, "--auth-file"));
    } else if (argument.startsWith("--url=")) {
      origin = requiredInlineValue(argument, "--url");
    } else {
      throw new Error(`unknown auth show option: ${argument}`);
    }
  }
  if (scope === null) throw new Error("auth show requires --scope story|admin");
  if (authFile !== null && origin !== null) {
    throw new Error("auth show accepts either --url or --auth-file, not both");
  }
  // ADR007 removed the fixed port, so there is no origin to assume.
  if (authFile === null && origin === null) {
    throw new Error("auth show requires --url <base-url> or --auth-file <path>");
  }
  const target: { origin: string } | { file: string } = authFile === null
    ? { origin: origin as string }
    : { file: authFile };
  if (output.isTTY !== true) {
    throw new Error("auth show refuses to print a capability to non-TTY output");
  }
  const selected = "origin" in target
    ? await readHttpAuthRecord(target.origin)
    : await readHttpAuthRecordFile(target.file);
  const attach = await attachHttpServer(selected.record.origin, selected.paths.final);
  output.write(`1667 instance: ${attach.authRecord.instanceId}\n`);
  output.write(`${scope} capability: ${attach.authRecord.capabilities[scope]}\n`);
}

export async function startLegacyServe(
  dataDirInput: string,
  options: {
    readonly port?: number;
    readonly printLogs?: boolean;
  } = {}
): Promise<HttpListener> {
  const dataDir = resolve(dataDirInput);
  return await startHttpListener({
    port: options.port ?? 0,
    printLogs: options.printLogs === true,
    serviceFactory: async (errorReporter) => {
      const legacyData = await validateLegacyServeDataDirectory(dataDir);
      return new StoryService({
        legacyData,
        dataLock: "external",
        mutationRecovery: "external",
        settingsActivation: "recover-only",
        errorReporter
      });
    },
    mutationGate: new SingleMutationGate()
  });
}

async function runLegacyServe(argv: string[]): Promise<void> {
  let dataDir: string | null = null;
  let legacy = false;
  let portSupplied = false;
  let printLogs = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--legacy-v1") legacy = true;
    else if (argument === "--print-logs") printLogs = true;
    else if (argument === "--data" || argument === "--port") {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${argument} requires a value`);
      if (argument === "--data") dataDir = value;
      else portSupplied = true;
    } else if (argument.startsWith("--data=")) {
      dataDir = requiredInlineValue(argument, "--data");
    } else if (argument.startsWith("--port=")) {
      portSupplied = true;
    } else {
      throw new Error(`unknown serve option: ${argument}`);
    }
  }
  if (!legacy) throw new Error("serve currently requires --legacy-v1");
  if (portSupplied) throw new Error("serve --legacy-v1 rejects --port");
  if (dataDir === null) throw new Error("serve requires --data <path>");
  process.stderr.write(
    "Legacy read-only preview: no automatic restart; an interrupted mutation may have an unknown outcome.\n"
  );
  try {
    await runHttpListenerUntilSignal(
      async () => await startLegacyServe(dataDir, { printLogs }),
      (listener) => {
        process.stdout.write(
          `1667 legacy server listening on ${listener.origin}\n`
        );
      }
    );
  } catch (error) {
    throw sanitizeLegacyServeFailure(error);
  }
}

export function sanitizeLegacyServeFailure(error: unknown): Error {
  const reference = internalErrorReference(error);
  const message = toPublicServiceError(error).message;
  return new Error(
    `${message}${reference === null ? "" : ` (${reference})`}`,
    { cause: error }
  );
}

function parseScope(value: string): HttpCapabilityScope {
  if (value === "story" || value === "admin") return value;
  throw new Error("--scope must be story or admin");
}

function requiredInlineValue(argument: string, flag: string): string {
  const value = argument.slice(flag.length + 1);
  if (value.length === 0) throw new Error(`${flag} requires a value`);
  return value;
}
