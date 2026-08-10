import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  GENERATION_METHODS
} from "../shared/worker-protocol.js";
import {
  decodeSupervisorToChildMessage,
  supervisedOperationKey,
  type ChildToSupervisorMessage,
  type HttpSupervisedOperationDescriptor,
  type SupervisorToChildMessage,
  type SupervisedRecoveryState
} from "../shared/supervised-serve-protocol.js";
import {
  MAX_CREDENTIAL_NAMES_PER_STATE,
  isCredentialEnvironmentName
} from "../shared/credential-slot-policy.js";
import {
  settingsStateEnvironmentCredentialNames
} from "../shared/settings-credential-slots.js";
import {
  decodeSupervisedSecrets,
  SUPERVISED_SECRET_CHANNEL_MAX_BYTES
} from "../shared/supervised-secret-channel.js";
import { SETTINGS_STATE_V2_FILE } from "./data-directory-layout.js";
import { parseSettingsStateV2Bytes } from "./settings-v2-codec.js";
import { RuntimeDataDirectoryLock } from "./runtime-data-directory.js";
import { startHttpListener, type HttpListener } from "./http-listener.js";
import { StoryService } from "./story-service.js";
import {
  createProjectTier,
  resolveProject,
  type ResolvedProject
} from "./project-discovery.js";
import { PROJECT_DIRECTORY_NAME } from "./project-layout.js";
import {
  PublicRuntimeError
} from "./errors.js";
import { assertHttpPlatformSupport } from "./http-platform-support.js";
import { resolveDiagnosticMachineTier } from "./diagnostic-machine-tier.js";
import { resolveMachineTierRootPath } from "./machine-tier.js";
import {
  assertMachineTierOutsideDirectory
} from "./machine-tier-boundary.js";
import {
  InternalErrorReporter,
  InternalErrorReporterLease
} from "./internal-error-reporter.js";
import { localStartupFailure } from "./local-startup-failure.js";
import { failureMessageFields } from "../shared/failure-envelope.js";
import { toPublicServiceError } from "./service-error-policy.js";
import { refuseSealedVaultForHttp } from "./vault-access-policy.js";

interface IpcProcess extends NodeJS.Process {
  send?: (message: ChildToSupervisorMessage) => boolean;
}

const ipc = process as IpcProcess;

export interface SupervisedServeChildDependencies {
  /** @internal Deterministic test seam before the retained vault check. */
  readonly beforeLockedVaultCheck?: (authorityPath: string) => Promise<void>;
}

export async function runSupervisedServeChild(
  argv: readonly string[],
  dependencies: SupervisedServeChildDependencies = {}
): Promise<void> {
  if (ipc.send === undefined) {
    throw new PublicRuntimeError(
      "Supervised child requires a private IPC channel"
    );
  }
  const printLogs = argv.includes("--print-logs");
  let project: ResolvedProject;
  let machineDir: string;
  try {
    assertHttpPlatformSupport();
    project = await resolveSupervisedProject(argv);
    const prospectiveMachineDir = await resolveDiagnosticMachineTier(
      undefined,
      {
        service: "supervised-child-startup",
        operation: "machine-tier-resolution"
      },
      {
        print: printLogs,
        resolve: resolveMachineTierRootPath
      }
    );
    await assertSupervisedMachineTierOutsideProject(
      project,
      prospectiveMachineDir
    );
    machineDir = await resolveDiagnosticMachineTier(
      undefined,
      {
        service: "supervised-child-startup",
        operation: "machine-tier-resolution"
      },
      { print: printLogs }
    );
    // The resolved directory is the path that receives diagnostics and
    // credentials. Recheck it against the same selected project immediately
    // before the first persistent file is opened.
    await assertSupervisedMachineTierOutsideProject(project, machineDir);
  } catch (error) {
    send({
      type: "fatal",
      message: toPublicServiceError(localStartupFailure(error)).message
    });
    process.exitCode = 1;
    return;
  }
  const errorReporter = await InternalErrorReporter.open(machineDir, {
    print: printLogs
  });
  const errorReporterLease = new InternalErrorReporterLease(errorReporter);
  try {
    await runSupervisedServeChildCore(
      argv,
      machineDir,
      errorReporterLease,
      project,
      dependencies
    );
  } catch (error) {
    const reported = await errorReporter.report(localStartupFailure(error), {
      service: "supervised-child-startup",
      operation: "bootstrap"
    });
    send({
      type: "fatal",
      ...failureMessageFields(reported.failure)
    });
    process.exitCode = 1;
  } finally {
    await errorReporterLease.close().catch(() => undefined);
  }
}

export async function assertSupervisedMachineTierOutsideProject(
  project: ResolvedProject,
  machineDirectory: string
): Promise<void> {
  await assertMachineTierOutsideDirectory(
    project.root,
    machineDirectory,
    "Supervised serve requires the machine tier outside the project"
  );
}

export async function resolveSupervisedProject(
  argv: readonly string[],
  cwd = process.cwd()
): Promise<ResolvedProject> {
  const configuredDataDir = optionalValueAfter(argv, "--data");
  const outcome = await resolveProject({
    cwd,
    ...(configuredDataDir === null ? {} : { data: configuredDataDir })
  });
  if (outcome.kind === "absent") {
    throw new PublicRuntimeError(
      `no ${PROJECT_DIRECTORY_NAME} story project in ${outcome.cwd} or any `
        + "parent. Run '1667 init' there first, or pass --data <project-root>."
    );
  }
  return outcome.project;
}

async function runSupervisedServeChildCore(
  argv: readonly string[],
  machineDir: string,
  errorReporterLease: InternalErrorReporterLease,
  project: ResolvedProject,
  dependencies: SupervisedServeChildDependencies
): Promise<void> {
  const dataDir = project.exists
    ? project.directory
    : await createProjectTier(project.directory);
  await refuseSealedVaultForHttp(dataDir, "serve");
  const port = Number(valueAfter(argv, "--port"));
  const secretFd = Number(valueAfter(argv, "--secret-fd"));
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new PublicRuntimeError("Supervised child port is invalid");
  }
  if (secretFd !== 4) {
    throw new PublicRuntimeError(
      "Supervised child secret channel is invalid"
    );
  }
  const messages = new MessageInbox();
  let dataLock: RuntimeDataDirectoryLock | null = null;
  let listener: HttpListener | null = null;
  let service: StoryService | null = null;
  let admissionOpen = false;
  const reserveWaiters = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  messages.onReserveAck = (message) => {
    const waiter = reserveWaiters.get(message.requestId);
    if (waiter === undefined) return;
    reserveWaiters.delete(message.requestId);
    if (message.accepted) waiter.resolve();
    else waiter.reject(new Error("Supervisor operation capacity is full"));
  };

  let run:
    | { readonly kind: "success" }
    | { readonly kind: "failure"; readonly error: unknown } = {
      kind: "success"
    };
  try {
    let displayDataDir = dataDir;
    listener = await startHttpListener({
      port,
      machineDir,
      project: { root: project.root, dataDir },
      errorReporterLease,
      printLogs: argv.includes("--print-logs"),
      projectAuthority: {
        announceProjectServer: async (server, signal) => {
          await dataLock?.announceProjectServer(server, signal);
        },
        release: async () => {
          await dataLock?.release();
        }
      },
      serviceFactory: async (errorReporter, machineDir, listenerProject) => {
        const acquiredDataLock = new RuntimeDataDirectoryLock(
          listenerProject.dataDir
        );
        dataLock = acquiredDataLock;
        displayDataDir = await acquiredDataLock.acquire({
          beforeMigration: async () => {
            const authorityPath = acquiredDataLock.authorityPath;
            await dependencies.beforeLockedVaultCheck?.(authorityPath);
            await refuseSealedVaultForHttp(authorityPath, "serve");
          }
        });
        const lockedDataDir = acquiredDataLock.authorityPath;
        await installRequestedSecrets(
          await credentialNames(lockedDataDir),
          secretFd
        );
        return service = new StoryService({
          dataDir: lockedDataDir,
          machineDir,
          dataLock: "external",
          errorReporter,
          starterVault: "seed-when-new",
          freshDataDirectory: acquiredDataLock.initializedNewDirectory
        });
      },
      operationSessions: {
        lifecycle: {
          kind: "supervised",
          isAdmissionOpen: () => admissionOpen,
          admit: async (descriptor) => {
            if (!admissionOpen) {
              throw new Error("Supervised serve admission is closed");
            }
            await new Promise<void>((resolve, reject) => {
              reserveWaiters.set(supervisedOperationKey(descriptor), {
                resolve,
                reject
              });
              send({
                type: "reserve",
                requestId: supervisedOperationKey(descriptor),
                descriptor
              });
            });
          },
          terminal: (descriptor) => send({ type: "terminal", descriptor }),
          hardDeadline: ({ sessionId, sequence }) => send({
            type: "hard-deadline",
            sessionId,
            sequence: sequence.toString()
          })
        }
      }
    });

    const recovery = await messages.next("recover");
    if (recovery.descriptors.length > 0) {
      send({
        type: "recovered",
        results: await recoverDescriptors(service!, recovery.descriptors)
      });
      await messages.next("activate");
    }
    admissionOpen = true;
    await listener.announceProjectServer();
    send({
      type: "ready",
      origin: listener.origin,
      dataDir: displayDataDir
    });
    await messages.next("shutdown");
  } catch (error) {
    run = {
      kind: "failure",
      error: listener === null ? localStartupFailure(error) : error
    };
  }
  if (listener === null) {
    if (run.kind === "failure") throw run.error;
    throw new Error("Supervised child exited without a listener");
  }
  if (run.kind === "success") return await listener.close();
  try {
    await listener.close({
      error: run.error,
      operation: "supervised-child"
    });
  } catch (reportedError) {
    throw reportedError;
  }
  throw run.error;
}

export async function recoverDescriptors(
  service: StoryService,
  descriptors: readonly HttpSupervisedOperationDescriptor[]
): Promise<{
  readonly sessionId: string;
  readonly sequence: string;
  readonly state: SupervisedRecoveryState;
}[]> {
  const results = [];
  for (const descriptor of descriptors) {
    let state: SupervisedRecoveryState;
    if (descriptor.mutationId === null) {
      state = "not-committed";
    } else {
      const receipt = await service.inspectMutationReceipt(
        descriptor.mutationId,
        descriptor.operation
      );
      if (receipt === null) {
        state = "not-committed";
      } else if (receipt.state === "provider_started") {
        state = "generation-outcome-unknown";
      } else if (receipt.state === "completed" || receipt.state === "failed") {
        state = "committed";
      } else if (GENERATION_METHODS.has(descriptor.operation)) {
        state = "generation-outcome-unknown";
      } else {
        // A pending local receipt may be either side of its aggregate commit.
        // The killed request cannot have returned a response because terminal
        // receipt publication precedes handler return. Reopen admission so the
        // HTTP client's durable retry can replay the same ID and input through
        // the receipt's reconciliation path.
        state = "not-committed";
      }
    }
    results.push({
      sessionId: descriptor.sessionId,
      sequence: descriptor.sequence,
      state
    });
  }
  return results;
}

async function credentialNames(dataDir: string): Promise<string[]> {
  let state;
  try {
    state = parseSettingsStateV2Bytes(
      await readFile(path.join(dataDir, SETTINGS_STATE_V2_FILE))
    );
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return [];
    throw error;
  }
  const names = settingsStateEnvironmentCredentialNames(state);
  if (names.length > MAX_CREDENTIAL_NAMES_PER_STATE || names.some((name) =>
    !isCredentialEnvironmentName(name))) {
    throw new Error("Settings request invalid credential environment names");
  }
  return names;
}

async function installRequestedSecrets(
  names: readonly string[],
  secretFd: number
): Promise<void> {
  send({ type: "secret-request", names });
  const bytes = await readSecretChannel(secretFd);
  let values: Readonly<Record<string, string | null>>;
  try {
    values = decodeSupervisedSecrets(bytes);
  } finally {
    bytes.fill(0);
  }
  const keys = Object.keys(values);
  if (keys.length !== names.length
    || keys.some((key, index) => key !== names[index])) {
    throw new Error("Supervisor returned the wrong credential slots");
  }
  for (const [name, value] of Object.entries(values)) {
    if (value === null) delete process.env[name];
    else process.env[name] = value;
  }
  send({ type: "secret-ack" });
}

async function readSecretChannel(fd: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  const stream = createReadStream("", { fd, autoClose: true });
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > SUPERVISED_SECRET_CHANNEL_MAX_BYTES) {
      for (const item of chunks) item.fill(0);
      bytes.fill(0);
      stream.destroy();
      throw new Error("Supervised secret channel exceeded its bound");
    }
    chunks.push(bytes);
  }
  const result = Buffer.concat(chunks);
  for (const item of chunks) item.fill(0);
  return result;
}

class MessageInbox {
  private readonly queued: SupervisorToChildMessage[] = [];
  private readonly waiters = new Map<
    SupervisorToChildMessage["type"],
    Array<(message: never) => void>
  >();
  onReserveAck:
    ((message: Extract<SupervisorToChildMessage, { type: "reserve-ack" }>) => void)
    | null = null;

  constructor() {
    process.on("message", (value: unknown) => {
      const message = decodeSupervisorToChildMessage(value);
      if (message.type === "reserve-ack") {
        this.onReserveAck?.(message);
        return;
      }
      const waiter = this.waiters.get(message.type)?.shift();
      if (waiter === undefined) this.queued.push(message);
      else waiter(message as never);
    });
  }

  async next<T extends SupervisorToChildMessage["type"]>(
    type: T
  ): Promise<Extract<SupervisorToChildMessage, { type: T }>> {
    const index = this.queued.findIndex((message) => message.type === type);
    if (index >= 0) {
      return this.queued.splice(index, 1)[0] as Extract<
        SupervisorToChildMessage,
        { type: T }
      >;
    }
    return await new Promise((resolve) => {
      const waiters = this.waiters.get(type) ?? [];
      waiters.push(resolve as (message: never) => void);
      this.waiters.set(type, waiters);
    });
  }
}

function send(message: ChildToSupervisorMessage): void {
  if (ipc.send?.(message) !== true) {
    throw new Error("Supervised child IPC channel is unavailable");
  }
}

function valueAfter(argv: readonly string[], flag: string): string {
  const index = argv.indexOf(flag);
  const value = index < 0 ? undefined : argv[index + 1];
  if (value === undefined || value.length === 0) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function optionalValueAfter(
  argv: readonly string[],
  flag: string
): string | null {
  const index = argv.indexOf(flag);
  if (index < 0) return null;
  const value = argv[index + 1];
  if (value === undefined || value.length === 0) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
