import { renderOnce, runInteractive, type AppSource } from "./app.js";
import { createApi } from "./api.js";
import { demoAppSource } from "./demo.js";
import { createConnectionMonitor } from "./connection.js";
import { loadConfig } from "./config.js";
import { resolve } from "node:path";
import {
  BackendRestartRequiredError,
  createWorkerStoryApi,
  exitForBackendRestart,
  WorkerApiError
} from "./worker-api.js";
import type { HttpRecoveryWarning } from "../../shared/http-protocol.js";
import {
  AI_1667_BUILD_IDENTITY,
  formatBuildVersion
} from "../../shared/build-identity.js";
import { RecoveryWarningFeed } from "./recovery-warning-feed.js";
import { runProcessUpgrade } from "./upgrade-cli.js";
import { createBackgroundUpdateStarter } from "./update-runtime.js";
import { attachHttpServer } from "./http-attach.js";
import { runHttpCommand } from "./http-commands.js";
import { parseCanonicalLoopbackOrigin } from "../../shared/http-loopback-origin.js";
import { resolvePlatformDataDirectory } from "../../server/platform-data-directory.js";
import {
  classifyDataDirectoryAdmission
} from "../../server/data-directory-admission.js";

interface Arguments {
  url: string | null;
  authFile: string | null;
  dataDir: string | null;
  initializeNew: boolean;
  offlineExclusive: boolean;
  diagnostic: boolean;
  embedded: boolean;
  storyId: string | null;
  demo: boolean;
  renderOnce: boolean;
  width: number;
  height: number;
  dense: boolean;
  keys: string;
}

const HELP = `1667 — a full-screen 1667 client

Usage: 1667 [options]
       1667 auth show --scope <story|admin> [--url <base-url> | --auth-file <path>]
       1667 serve [--data <absolute-path>] [--port <0-65535>]
                  [--initialize-new --offline-exclusive]
       1667 serve --legacy-v1 --offline-exclusive --data <path>
       1667 upgrade [options]

Options:
  --story <id>       Open a story; defaults to the most recently updated
  --url <base-url>   Connect to a loopback 1667 HTTP server
  --auth-file <path> Use the canonical private auth record for --url
  --embedded         Use the embedded backend (default)
  --data <path>      Data directory override (packaged builds require absolute)
  --initialize-new   Authorize publication of an absent data target
  --offline-exclusive Assert every lock-unaware writer is stopped
  --diagnostic       Print read-only startup/data eligibility JSON
  --demo             Use the in-memory lantern keeper fixture
  --render-once      Print one deterministic frame and exit
  --size <WxH>       Render-once dimensions (default: 120x36)
  --keys <sequence>  Feed keys through the app before --render-once capture
  --debug-density    Give the demo focus part 20 takes
  -h, --help         Show help
  --version [--json] Print embedded build identity`;

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (await runHttpCommand(argv)) return;
  if (argv[0] === "upgrade") {
    await runProcessUpgrade(argv.slice(1));
    return;
  }
  const parsed = parseArguments(argv);
  if (parsed === null) return;
  if (parsed.diagnostic) {
    await printStartupDiagnostic(parsed.dataDir);
    return;
  }
  const loaded = await loadSource(parsed);
  try {
    if (parsed.renderOnce) {
      process.stdout.write(`${await renderOnce(loaded.source, parsed.width, parsed.height, parsed.keys)}\n`);
      return;
    }
    await runInteractive(loaded.source);
  } finally {
    await loaded.dispose();
  }
}

export function parseArguments(argv: string[]): Arguments | null {
  let url = process.env.AI_1667_URL ?? null;
  let dataDir = process.env.AI_1667_DATA ?? null;
  let authFile: string | null = null;
  let explicitEmbedded = false;
  let explicitUrl = false;
  let explicitData = false;
  let initializeNew = false;
  let offlineExclusive = false;
  let diagnostic = false;
  let storyId: string | null = null;
  let demo = false;
  let render = false;
  let width = 120;
  let height = 36;
  let dense = false;
  let keys = "";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(`${HELP}\n`);
      return null;
    }
    if (arg === "--version") {
      const json = argv[index + 1] === "--json";
      if (index !== 0 || argv.length !== (json ? 2 : 1)) {
        usageError("--version only accepts an optional trailing --json");
      }
      process.stdout.write(json
        ? `${JSON.stringify(AI_1667_BUILD_IDENTITY)}\n`
        : `${formatBuildVersion()}\n`);
      return null;
    }
    if (arg.startsWith("--url=")) {
      url = requiredInlineValue(arg, "--url");
      explicitUrl = true;
    }
    else if (arg.startsWith("--data=")) {
      dataDir = requiredInlineValue(arg, "--data");
      explicitData = true;
    }
    else if (arg.startsWith("--auth-file=")) {
      authFile = requiredInlineValue(arg, "--auth-file");
    }
    else if (arg.startsWith("--story=")) storyId = requiredInlineValue(arg, "--story");
    else if (arg.startsWith("--size=")) {
      ({ width, height } = parseSize(requiredInlineValue(arg, "--size")));
    } else if (arg.startsWith("--keys=")) keys = requiredInlineValue(arg, "--keys");
    else if (arg === "--demo") demo = true;
    else if (arg === "--embedded") explicitEmbedded = true;
    else if (arg === "--initialize-new") initializeNew = true;
    else if (arg === "--offline-exclusive") offlineExclusive = true;
    else if (arg === "--diagnostic") diagnostic = true;
    else if (arg === "--render-once") render = true;
    else if (arg === "--debug-density") dense = true;
    else if (arg === "--url" || arg === "--data" || arg === "--auth-file"
      || arg === "--story" || arg === "--size" || arg === "--keys") {
      const value = requiredSeparatedValue(argv, index, arg);
      index += 1;
      if (arg === "--url") {
        url = value;
        explicitUrl = true;
      }
      else if (arg === "--data") {
        dataDir = value;
        explicitData = true;
      }
      else if (arg === "--auth-file") authFile = value;
      else if (arg === "--story") storyId = value;
      else if (arg === "--keys") keys = value;
      else ({ width, height } = parseSize(value));
    } else usageError(`unknown option: ${arg}`);
  }
  if (explicitEmbedded && explicitUrl) usageError("--embedded and --url cannot be used together");
  const embedded = explicitEmbedded || (!explicitUrl && url === null);
  if (!embedded && url !== null) parseCanonicalLoopbackOrigin(url);
  if (explicitData && !embedded) {
    usageError("--data requires embedded mode; unset AI_1667_URL or pass --embedded");
  }
  if (authFile !== null && embedded) usageError("--auth-file requires --url");
  if (explicitData && demo) usageError("--data cannot be used with --demo");
  if (initializeNew !== offlineExclusive) {
    usageError("--initialize-new and --offline-exclusive must be supplied together");
  }
  if (initializeNew && (!embedded || demo)) {
    usageError("--initialize-new requires the embedded backend");
  }
  if (diagnostic && (!embedded || demo)) {
    usageError("--diagnostic requires the embedded backend");
  }
  return {
    url,
    authFile,
    dataDir,
    initializeNew,
    offlineExclusive,
    diagnostic,
    embedded,
    storyId,
    demo,
    renderOnce: render,
    width,
    height,
    dense,
    keys
  };
}

async function printStartupDiagnostic(
  configured: string | null
): Promise<void> {
  const hardened = AI_1667_BUILD_IDENTITY.artifactTarget !== "source";
  let dataDir = configured ?? "<platform-default>";
  try {
    dataDir = resolveEmbeddedDataDirectory(configured);
    const admission = hardened
      ? await classifyDataDirectoryAdmission(dataDir)
      : { kind: "source-preview" as const };
    process.stdout.write(`${JSON.stringify({
      schema: 1,
      buildIdentity: AI_1667_BUILD_IDENTITY,
      backend: "embedded",
      hardened,
      dataDirectory: {
        path: dataDir,
        admission: admission.kind
      }
    })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      schema: 1,
      buildIdentity: AI_1667_BUILD_IDENTITY,
      backend: "embedded",
      hardened,
      dataDirectory: {
        path: dataDir,
        admission: "refused",
        error: {
          code: serviceErrorCode(error),
          message: error instanceof Error ? error.message : String(error)
        }
      }
    })}\n`);
    process.exitCode = 1;
  }
}

function serviceErrorCode(error: unknown): string {
  return error !== null
    && typeof error === "object"
    && "code" in error
    && typeof error.code === "string"
    ? error.code
    : "internal";
}

function requiredInlineValue(argument: string, flag: string): string {
  const value = argument.slice(flag.length + 1);
  if (value.length === 0) usageError(`${flag} requires a value`);
  return value;
}

function requiredSeparatedValue(
  argv: readonly string[],
  index: number,
  flag: string
): string {
  const value = argv[index + 1];
  if (value === undefined || value.trim().length === 0 || value.startsWith("-")) {
    usageError(`${flag} requires a non-option value; use ${flag}=... for a value beginning with '-'`);
  }
  return value;
}

function parseSize(value: string): { width: number; height: number } {
  const match = /^(\d+)x(\d+)$/.exec(value);
  if (match === null) usageError("--size must be formatted as WxH");
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 20 || height < 10) usageError("--size must be at least 20x10");
  return { width, height };
}

interface LoadedSource {
  source: AppSource;
  dispose(): Promise<void>;
}

async function loadSource(args: Arguments): Promise<LoadedSource> {
  if (args.demo) return { source: demoAppSource(args.dense), dispose: async () => {} };
  const dataDir = args.embedded
    ? resolveEmbeddedDataDirectory(args.dataDir)
    : null;
  const storyFolder = dataDir === null
    ? ""
    : storyFolderForBackend(true, dataDir);
  const worker = dataDir === null ? null : await createWorkerStoryApi({
    dataDir,
    initializeNew: args.initializeNew,
    offlineExclusive: args.offlineExclusive
  });
  const httpAttach = worker === null
    ? await attachHttpServer(args.url ?? "http://127.0.0.1:7373", args.authFile)
    : null;
  const backendRecovery = new RecoveryWarningFeed();
  if (worker !== null) {
    try {
      // Startup remains non-interactive until retained mutations settle. The
      // first rendered payload is therefore already authoritative.
      backendRecovery.publish(await worker.recovery, true);
    } catch (error) {
      backendRecovery.fail(error);
      await worker.dispose();
      throw error;
    }
  }
  const backendApi = worker === null
    ? createApi(httpAttach!.origin, (metadata) => {
      return backendRecovery.publish(metadata.recoveryWarnings.map(httpRecoveryWarning));
    }, httpAttach!)
    : worker.api;
  const connection = createConnectionMonitor(backendApi);
  const api = connection.api;
  try {
    let [stories, settingsView] = await Promise.all([api.listStories(), api.getSettings()]);
    const storyId = args.storyId ?? stories
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]?.id;
    let payload: Awaited<ReturnType<typeof api.loadStory>>;
    if (storyId === undefined) {
      payload = await backendRecovery.runAdoptionMutation(() => api.createStory());
      stories = await api.listStories();
    } else {
      try {
        payload = await api.loadStory(storyId);
      } catch (error) {
        if (worker === null || args.storyId !== null || !isWorkerNotFound(error)) throw error;
        stories = await api.listStories();
        const fallbackId = stories.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]?.id;
        payload = fallbackId === undefined ? await api.createStory() : await api.loadStory(fallbackId);
      }
    }
    const config = loadConfig();
    const startUpdateCheck = createBackgroundUpdateStarter(config);
    const source = { payload, api, demo: false,
      stories, settingsView, settings: settingsView.effective,
      storyFolder, connection, ...(worker === null ? {} : { backendFailure: worker.failure }),
      backendRecovery,
      ...(startUpdateCheck === null ? {} : { startUpdateCheck }),
      config };
    return {
      source,
      dispose: async () => {
        connection.dispose();
        httpAttach?.dispose();
        await worker?.dispose();
      }
    };
  } catch (error) {
    connection.dispose();
    httpAttach?.dispose();
    await worker?.dispose();
    throw error;
  }
}

function httpRecoveryWarning(warning: HttpRecoveryWarning) {
  return {
    mutationId: warning.mutationId,
    method: warning.method,
    storyId: warning.storyId,
    resolution: "archived" as const,
    error: new WorkerApiError(warning.message, warning.code, warning.status)
  };
}

export function storyFolderForBackend(
  embedded: boolean,
  dataDir = resolveEmbeddedDataDirectory(),
  home = process.env.HOME
): string {
  if (!embedded) return "";
  const absolute = resolve(dataDir, "stories");
  return home !== undefined && absolute.startsWith(home) ? `~${absolute.slice(home.length)}` : absolute;
}

export function resolveEmbeddedDataDirectory(
  configured: string | null | undefined = process.env.AI_1667_DATA,
  cwd = process.cwd()
): string {
  return resolvePlatformDataDirectory({
    ...(configured == null ? {} : { configured }),
    packaged: AI_1667_BUILD_IDENTITY.artifactTarget !== "source",
    cwd
  });
}

function isWorkerNotFound(error: unknown): boolean {
  return error instanceof WorkerApiError && error.status === 404;
}

function usageError(message: string): never {
  throw new UsageError(message);
}

class UsageError extends Error {}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  try {
    await main(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`1667: ${error.message}\nTry '1667 --help'.\n`);
      process.exitCode = 2;
      return;
    }
    if (error instanceof BackendRestartRequiredError) exitForBackendRestart();
    process.stderr.write(`1667: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith("/src/main.ts") === true) {
  void runCli();
}
