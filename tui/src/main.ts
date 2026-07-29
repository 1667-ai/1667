import { renderOnce, runInteractive, type AppSource } from "./app.js";
import { createApi } from "./api.js";
import { demoAppSource } from "./demo.js";
import { createConnectionMonitor } from "./connection.js";
import { loadConfig } from "./config.js";
import {
  configureReadingPositionStore,
  flushReadingPositionPersist,
  loadReadingPositions,
  readingPositionStoreFile
} from "./reading-position-store.js";
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
import { runStoryExport } from "./export-cli.js";
import { runHttpCommand } from "./http-commands.js";
import { parseCanonicalLoopbackOrigin } from "../../shared/http-loopback-origin.js";
import {
  createCompatibleHttpFailureEnvelope
} from "../../shared/failure-envelope.js";
import { resolveMachineTierRoot } from "../../server/machine-tier.js";
import { resolvePlatformDataDirectory } from "../../server/platform-data-directory.js";
import { adoptDataDirectory } from "../../server/project-adoption.js";
import {
  createProjectTier,
  initializeProject,
  PROJECT_DIRECTORY_NAME,
  resolveProject,
  type ProjectOutcome,
  type ProjectRequest,
  type ResolvedProject
} from "../../server/project-discovery.js";
import {
  readProjectRunRecord
} from "../../server/project-run-record.js";
import {
  canPromptForProject,
  confirmProjectCreation
} from "./project-prompt.js";

interface Arguments {
  url: string | null;
  authFile: string | null;
  dataDir: string | null;
  global: boolean;
  diagnostic: boolean;
  printLogs: boolean;
  embedded: boolean;
  storyId: string | null;
  demo: boolean;
  renderOnce: boolean;
  width: number;
  height: number;
  dense: boolean;
  keys: string;
}

export const HELP = `1667 — a full-screen 1667 client

Stories live in .1667/ beside your writing, found by walking up from the
current directory the way git finds .git.

Usage: 1667 [options]
       1667 init [--adopt [--from <legacy-data-dir>]]
       1667 export [--story <id>] [--force] [--data <path>|--global]
       1667 auth show --scope <story|admin> [--url <base-url> | --auth-file <path>]
       1667 serve [--data <path>] [--port <0-65535>] [--print-logs]
       1667 serve --legacy-v1 --data <path> [--print-logs]
       1667 upgrade [options]

Export:
  Writes one story's selected line — the take chosen at each part, as you
  last left it — to the project root as markdown. Prose only: chapters
  become '##' headings; directions and unchosen takes stay behind. No option
  picks the line, so choose it in the app first.
  Defaults to the most recently updated story. Never clobbers an existing
  file (story.md, story-2.md, …) unless --force. 1667 never reads an
  exported file back.

Options:
  --story <id>       Open a story, or name the one to export; both default
                     to the most recently updated
  --url [base-url]   Connect to a loopback 1667 HTTP server; bare reads run.json
  --auth-file <path> Use the canonical private auth record for --url
  --embedded         Use the embedded backend (default)
  --data <path>      Open this project root instead of discovering one
  --global           Open the machine-wide project instead of a folder
  --diagnostic       Print read-only startup/project resolution JSON
  --print-logs       Also print unexpected embedded backend errors to stderr
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
  if (argv[0] === "init") {
    await runProjectInit(argv.slice(1));
    return;
  }
  if (argv[0] === "export") {
    await runStoryExport(argv.slice(1));
    return;
  }
  const parsed = parseArguments(argv);
  if (parsed === null) return;
  if (parsed.diagnostic) {
    await printStartupDiagnostic(parsed);
    return;
  }
  const loaded = await loadSource(parsed);
  if (loaded === null) return;
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
  let global = false;
  let diagnostic = false;
  let printLogs = false;
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
    else if (arg === "--url" && isBareFlag(argv, index)) {
      // A bare --url attaches to the server this project published.
      url = null;
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
    else if (arg === "--global") global = true;
    else if (arg === "--diagnostic") diagnostic = true;
    else if (arg === "--print-logs") printLogs = true;
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
  if (explicitUrl && url === null && authFile !== null) {
    usageError("--auth-file needs the --url it belongs to");
  }
  if (explicitData && !embedded) {
    usageError("--data requires embedded mode; unset AI_1667_URL or pass --embedded");
  }
  if (authFile !== null && embedded) usageError("--auth-file requires --url");
  if (explicitData && demo) usageError("--data cannot be used with --demo");
  if (global && explicitData) usageError("--global and --data select different projects");
  if (global && demo) usageError("--global cannot be used with --demo");
  if (global && !embedded) usageError("--global requires the embedded backend");
  if (diagnostic && (!embedded || demo)) {
    usageError("--diagnostic requires the embedded backend");
  }
  if (printLogs && (!embedded || demo)) {
    usageError("--print-logs requires the embedded backend");
  }
  return {
    url,
    authFile,
    dataDir,
    global,
    diagnostic,
    printLogs,
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

/** Read-only startup report. Discovery never writes, so an absent project is
 * an ordinary answer here rather than a prompt or a refusal. */
async function printStartupDiagnostic(args: Arguments): Promise<void> {
  const base = {
    schema: 2,
    buildIdentity: AI_1667_BUILD_IDENTITY,
    backend: "embedded",
    packaged: AI_1667_BUILD_IDENTITY.artifactTarget !== "source"
  };
  try {
    const outcome = await resolveProject(projectRequest(args));
    process.stdout.write(`${JSON.stringify({
      ...base,
      project: outcome.kind === "absent"
        ? { source: "absent", cwd: outcome.cwd }
        : {
            source: outcome.project.source,
            root: outcome.project.root,
            directory: outcome.project.directory,
            exists: outcome.project.exists
          }
    })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      ...base,
      project: {
        source: "refused",
        error: {
          code: serviceErrorCode(error),
          message: error instanceof Error ? error.message : String(error)
        }
      }
    })}\n`);
    process.exitCode = 1;
  }
}

async function runProjectInit(argv: readonly string[]): Promise<void> {
  let adopt = false;
  let from: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--adopt") adopt = true;
    else if (argument.startsWith("--from=")) from = requiredInlineValue(argument, "--from");
    else if (argument === "--from") {
      from = requiredSeparatedValue(argv, index, "--from");
      index += 1;
    } else usageError(`unknown init option: ${argument}`);
  }
  if (from !== null && !adopt) usageError("--from requires --adopt");
  if (!adopt) {
    const project = await initializeProject(process.cwd());
    process.stdout.write(`1667 story project: ${project.directory}\n`);
    return;
  }
  const adoption = await adoptDataDirectory({
    source: from ?? resolvePlatformDataDirectory({ packaged: true }),
    projectRoot: process.cwd(),
    machineDir: await resolveMachineTierRoot()
  });
  process.stdout.write(`1667 story project: ${adoption.project.directory}\n`);
  process.stdout.write(
    `adopted ${adoption.movedEntries.length} entries from ${adoption.source}\n`
  );
  if (adoption.relocatedSecretIds.length > 0) {
    process.stdout.write(
      `moved ${adoption.relocatedSecretIds.length} provider secret(s) `
        + "into the machine tier\n"
    );
  }
}

function projectRequest(args: Arguments): ProjectRequest {
  return {
    cwd: process.cwd(),
    ...(args.dataDir === null ? {} : { data: args.dataDir }),
    ...(args.global ? { global: true } : {})
  };
}

/**
 * Resolve where to attach. A bare `--url` reads the advisory run record this
 * project's server published; the record may be stale, so a refused connection
 * is reported as such rather than treated as a broken project.
 */
async function attachOrigin(args: Arguments): Promise<string> {
  if (args.url !== null) return args.url;
  const project = requireExistingProject(
    await resolveProject(projectRequest(args)),
    "attach to"
  );
  const record = await readProjectRunRecord(project.directory);
  if (record?.url == null) {
    throw new Error(
      `no 1667 server is recorded for ${project.directory}. `
        + "Start one with 1667 serve, or pass --url <base-url>."
    );
  }
  return record.url;
}

/**
 * Open the project this invocation names, asking once when none exists.
 * Returns null when the person declines, which is not an error.
 */
async function openProject(args: Arguments): Promise<ResolvedProject | null> {
  const outcome = await resolveProject(projectRequest(args));
  if (outcome.kind === "project") {
    // An explicitly named project — `--data` or `--global` — is explicit intent
    // to have one, so it is created. Discovery only ever finds existing ones.
    if (!outcome.project.exists) {
      await createProjectTier(outcome.project.directory);
      return { ...outcome.project, exists: true };
    }
    return outcome.project;
  }
  const streams = { input: process.stdin, output: process.stdout };
  if (!canPromptForProject(streams)) {
    throw new Error(
      `no ${PROJECT_DIRECTORY_NAME} story project in ${outcome.cwd} or any parent. `
        + "Run '1667 init', or use --global."
    );
  }
  if (!await confirmProjectCreation(outcome.cwd, streams)) {
    process.stdout.write(
      "1667: no story project created. Run '1667 init' here, "
        + "or '1667 --global' for one shared library.\n"
    );
    return null;
  }
  return await initializeProject(outcome.cwd);
}

/** Attaching and exporting read an existing project; neither invents one. */
function requireExistingProject(
  outcome: ProjectOutcome,
  action: string
): ResolvedProject {
  if (outcome.kind === "absent") {
    throw new Error(
      `no ${PROJECT_DIRECTORY_NAME} story project in ${outcome.cwd} or any `
        + `parent, so there is nothing to ${action}. Run '1667 init' first.`
    );
  }
  if (!outcome.project.exists) {
    throw new Error(
      `${outcome.project.directory} is not a 1667 story project yet, so there `
        + `is nothing to ${action}. Run '1667 init' there first.`
    );
  }
  return outcome.project;
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

/** A flag is bare when nothing follows it but the end of the line or another
 * option. An empty value is a mistake, and keeps its own error. */
function isBareFlag(argv: readonly string[], index: number): boolean {
  const value = argv[index + 1];
  return value === undefined || value.startsWith("-");
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

async function loadSource(args: Arguments): Promise<LoadedSource | null> {
  if (args.demo) return { source: demoAppSource(args.dense), dispose: async () => {} };
  let dataDir: string | null = null;
  // Exports land in the project root, beside the writing. A client
  // attached to a server has no project of its own and writes where it started.
  let exportDirectory = process.cwd();
  if (args.embedded) {
    const project = await openProject(args);
    if (project === null) return null;
    dataDir = project.directory;
    exportDirectory = project.root;
  }
  const storyFolder = dataDir === null
    ? ""
    : storyFolderForBackend(true, dataDir);
  const backendRecovery = new RecoveryWarningFeed();
  const worker = dataDir === null ? null : await createWorkerStoryApi({
    dataDir,
    printLogs: args.printLogs,
    onRecoveryWarnings: (warnings) => backendRecovery.publish(warnings)
  });
  let httpAttach = worker === null
    ? await attachHttpServer(await attachOrigin(args), args.authFile)
    : null;
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
  // Late-bound so listener replacement can refresh the cursor store after
  // the AppSource exists.
  const sourceHolder: { source: AppSource | null } = { source: null };
  if (httpAttach !== null) {
    const previousConfirm = httpAttach.confirmListenerReplacement.bind(httpAttach);
    httpAttach = {
      ...httpAttach,
      confirmListenerReplacement: async (previousInstanceId) => {
        const replaced = await previousConfirm(previousInstanceId);
        if (!replaced) return false;
        flushReadingPositionPersist();
        const nextFile = readingPositionStoreFile(null, {
          origin: httpAttach!.origin,
          instanceId: httpAttach!.authRecord.instanceId
        });
        configureReadingPositionStore(nextFile);
        const nextPositions = loadReadingPositions({ file: nextFile });
        if (sourceHolder.source !== null) {
          sourceHolder.source.readingPositions = nextPositions;
        }
        return true;
      }
    };
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
      payload = await backendRecovery.runRecoveryMutation(() => api.createStory());
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
    const storeFile = readingPositionStoreFile(
      dataDir,
      httpAttach === null
        ? null
        : {
          origin: httpAttach.origin,
          instanceId: httpAttach.authRecord.instanceId
        }
    );
    configureReadingPositionStore(storeFile);
    const readingPositions = loadReadingPositions({ file: storeFile });
    const startUpdateCheck = createBackgroundUpdateStarter(config);
    const source = { payload, api, demo: false,
      stories, settingsView, settings: settingsView.effective,
      storyFolder, exportDirectory, connection,
      ...(worker === null ? {} : { backendFailure: worker.failure }),
      backendRecovery,
      ...(startUpdateCheck === null ? {} : { startUpdateCheck }),
      config,
      readingPositions };
    sourceHolder.source = source;
    return {
      source,
      dispose: async () => {
        flushReadingPositionPersist();
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

export function httpRecoveryWarning(warning: HttpRecoveryWarning) {
  return {
    mutationId: warning.mutationId,
    method: warning.method,
    storyId: warning.storyId,
    ...(warning.providerRecovery === undefined
      ? {}
      : { providerRecovery: warning.providerRecovery }),
    resolution: "archived" as const,
    error: new WorkerApiError(createCompatibleHttpFailureEnvelope(
      warning,
      warning.diagnosticRef
    ))
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
    if (error instanceof BackendRestartRequiredError) exitForBackendRestart(error);
    process.stderr.write(`1667: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith("/src/main.ts") === true) {
  void runCli();
}
