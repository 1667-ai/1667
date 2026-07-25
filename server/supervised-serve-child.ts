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
import { resolveMachineTierRoot } from "./machine-tier.js";
import { announceProjectServer } from "./project-run-record.js";
import { StoryService } from "./story-service.js";
import { createProjectTier, resolveProject } from "./project-discovery.js";
import { PROJECT_DIRECTORY_NAME } from "./project-layout.js";

interface IpcProcess extends NodeJS.Process {
  send?: (message: ChildToSupervisorMessage) => boolean;
}

const ipc = process as IpcProcess;

export async function runSupervisedServeChild(
  argv: readonly string[]
): Promise<void> {
  if (ipc.send === undefined) {
    throw new Error("Supervised child requires a private IPC channel");
  }
  const configuredDataDir = optionalValueAfter(argv, "--data");
  // ADR007: `--data` names a project root here exactly as it does for the TUI,
  // so a served project and an opened project are the same lock.
  const outcome = await resolveProject({
    cwd: process.cwd(),
    ...(configuredDataDir === null ? {} : { data: configuredDataDir })
  });
  if (outcome.kind === "absent") {
    throw new Error(
      `no ${PROJECT_DIRECTORY_NAME} story project in ${outcome.cwd} or any `
        + "parent. Run '1667 init' there first, or pass --data <project-root>."
    );
  }
  const dataDir = outcome.project.exists
    ? outcome.project.directory
    : await createProjectTier(outcome.project.directory);
  const port = Number(valueAfter(argv, "--port"));
  const secretFd = Number(valueAfter(argv, "--secret-fd"));
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error("Supervised child port is invalid");
  }
  if (secretFd !== 4) throw new Error("Supervised child secret channel is invalid");
  const messages = new MessageInbox();
  const recovery = await messages.next("recover");
  const dataLock = new RuntimeDataDirectoryLock(dataDir);
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

  try {
    let displayDataDir = dataDir;
    listener = await startHttpListener({
      port,
      serviceFactory: async () => {
        displayDataDir = await dataLock.acquire();
        const lockedDataDir = dataLock.authorityPath;
        await installRequestedSecrets(
          await credentialNames(lockedDataDir),
          secretFd
        );
        return service = new StoryService({
          dataDir: lockedDataDir,
          machineDir: await resolveMachineTierRoot(),
          dataLock: "external",
          starterVault: "seed-when-new",
          freshDataDirectory: dataLock.initializedNewDirectory
        });
      },
      operationSessions: {
        lifecycle: {
          kind: "supervised",
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

    if (recovery.descriptors.length > 0) {
      send({
        type: "recovered",
        results: await recoverDescriptors(service!, recovery.descriptors)
      });
      await messages.next("activate");
    }
    admissionOpen = true;
    await announceProjectServer(displayDataDir, {
      port: listenerPort(listener.origin),
      url: listener.origin
    });
    send({
      type: "ready",
      origin: listener.origin,
      dataDir: displayDataDir
    });
    await messages.next("shutdown");
  } catch (error) {
    send({
      type: "fatal",
      message: error instanceof Error ? error.message : String(error)
    });
    process.exitCode = 1;
  } finally {
    await listener?.close().catch(() => undefined);
    await dataLock.release().catch(() => undefined);
  }
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

/** The listener reports the port it was given; the origin is the only carrier. */
function listenerPort(origin: string): number {
  const port = Number(new URL(origin).port);
  return Number.isSafeInteger(port) && port > 0 ? port : 80;
}
