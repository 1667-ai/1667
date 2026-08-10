import { renderOnce, runInteractive, type AppSource } from "./app.js";
import { createApi } from "./api.js";
import { HELP, commandHelp, wantsHelp } from "./cli-help.js";

export { HELP } from "./cli-help.js";
import { demoAppSource } from "./demo.js";
import { createConnectionMonitor } from "./connection.js";
import { loadConfig } from "./config.js";
import {
  configureReadingPositionStore,
  disposeReadingPositionStore,
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
import { runStoryImport } from "./import-cli.js";
import { runCardImport } from "./card-import-cli.js";
import { runLorebookImport } from "./lorebook-import-cli.js";
import { runProfileCommand } from "./profile-cli.js";
import { runHttpCommand } from "./http-commands.js";
import { runVaultDecrypt, runVaultEncrypt } from "./vault-cli.js";

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
  type ProjectRequest,
  type ResolvedProject
} from "../../server/project-discovery.js";
import { requireExistingProject } from "./project-command.js";
import {
  readProjectRunRecord
} from "../../server/project-run-record.js";
import {
  canPromptForProject,
  confirmProjectCreation
} from "./project-prompt.js";
import {
  openSealedVault,
  revalidateSealedVault,
  revalidateUnsealedVault
} from "./vault-open.js";

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

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const command = argv[0];
  if (command !== undefined && wantsHelp(argv.slice(1))) {
    const page = commandHelp(command);
    if (page !== null) {
      process.stdout.write(`${page}\n`);
      return;
    }
  }
  if (await runHttpCommand(argv)) return;
  if (argv[0] === "upgrade") {
    await runProcessUpgrade(argv.slice(1));
    return;
  }
  if (argv[0] === "init") {
    await runProjectInit(argv.slice(1));
    return;
  }
  if (argv[0] === "encrypt") {
    await runVaultEncrypt(argv.slice(1));
    return;
  }
  if (argv[0] === "decrypt") {
    await runVaultDecrypt(argv.slice(1));
    return;
  }
  if (argv[0] === "export") {
    await runStoryExport(argv.slice(1));
    return;
  }
  if (argv[0] === "import") {
    await runStoryImport(argv.slice(1));
    return;
  }
  if (argv[0] === "import-card") {
    await runCardImport(argv.slice(1));
    return;
  }
  if (argv[0] === "import-lorebook") {
    await runLorebookImport(argv.slice(1));
    return;
  }
  if (argv[0] === "profile") {
    await runProfileCommand(argv.slice(1));
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
    { unavailable: "nothing to attach to" }
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
interface OpenedProject {
  readonly project: ResolvedProject;
  readonly vault: Awaited<ReturnType<typeof openSealedVault>>;
}

async function openProject(args: Arguments): Promise<OpenedProject | null> {
  const outcome = await resolveProject(projectRequest(args));
  if (outcome.kind === "project") {
    // An explicitly named project — `--data` or `--global` — is explicit intent
    // to have one, so it is created. Discovery only ever finds existing ones.
    if (!outcome.project.exists) {
      await createProjectTier(outcome.project.directory);
      return { project: { ...outcome.project, exists: true }, vault: null };
    }
    return {
      project: outcome.project,
      vault: await openSealedVault(outcome.project.directory)
    };
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
  return { project: await initializeProject(outcome.cwd), vault: null };
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
  let vaultOptions: {
    readonly vaultKey: Buffer;
    readonly beforeVaultMigration: (lockedDataDirectory: string) => Promise<void>;
  } | undefined;
  // Exports land in the project root, beside the writing. A client
  // attached to a server has no project of its own and writes where it started.
  let exportDirectory = process.cwd();
  if (args.embedded) {
    const opened = await openProject(args);
    if (opened === null) return null;
    dataDir = opened.project.directory;
    exportDirectory = opened.project.root;
    const vault = opened.vault;
    if (vault !== null) {
      vaultOptions = {
        vaultKey: vault.key,
        beforeVaultMigration: async (lockedDataDirectory: string) => {
          await revalidateSealedVault(lockedDataDirectory, vault.keyslotBytes);
        }
      };
    }
  }
  const storyFolder = dataDir === null
    ? ""
    : storyFolderForBackend(true, dataDir);
  const backendRecovery = new RecoveryWarningFeed();
  const worker = dataDir === null ? null : await createWorkerStoryApi({
    dataDir,
    printLogs: args.printLogs,
    onRecoveryWarnings: (warnings) => backendRecovery.publish(warnings),
    ...(vaultOptions ?? { beforeVaultMigration: revalidateUnsealedVault })
  });
  let httpAttach = worker === null
    ? await attachHttpServer(await attachOrigin(args), {
        authFile: args.authFile
      })
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
      httpAttach?.origin ?? null
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
    return {
      source,
      dispose: async () => {
        disposeReadingPositionStore();
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
