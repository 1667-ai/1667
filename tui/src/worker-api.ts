import path from "node:path";
import { resolveDataDirectory } from "../../server/data-directory.js";
import { resolveDiagnosticMachineTier } from "../../server/diagnostic-machine-tier.js";
import { MutationOutbox } from "../../server/mutation-outbox.js";
import { RuntimeDataDirectoryLock } from "../../server/runtime-data-directory.js";
import { releaseOrRetainDataLock } from "./worker-data-lock.js";
import { storyApiFromWorkerTransport } from "./worker-story-api.js";
import { WorkerTransport } from "./worker-transport.js";
import type { WorkerStoryApi, WorkerStoryApiOptions } from "./worker-api-contract.js";

export { WorkerExitUnconfirmedError } from "./worker-data-lock.js";
export {
  BACKEND_RESTART_REQUIRED_EXIT_CODE,
  BackendRestartRequiredError,
  exitForBackendRestart,
  WorkerApiError,
  workerApiErrorFromFailure
} from "./worker-error.js";
export type {
  WorkerRecoveryWarning,
  WorkerStoryApi,
  WorkerStoryApiOptions
} from "./worker-api-contract.js";

export async function createWorkerStoryApi(options: WorkerStoryApiOptions = {}): Promise<WorkerStoryApi> {
  if (options.worker === undefined && options.machineDir === undefined) {
    // Resolving here, not in the worker, is what turns "this platform has no
    // private state root yet" into one line on stderr instead of a dead backend.
    options = {
      ...options,
      machineDir: await resolveDiagnosticMachineTier(
        undefined,
        {
          service: "embedded-worker-startup",
          operation: "machine-tier-resolution"
        },
        { print: options.printLogs === true }
      )
    };
  }
  const dataLock = options.worker === undefined
    ? new RuntimeDataDirectoryLock(resolveDataDirectory(options.dataDir))
    : null;
  if (dataLock !== null) await dataLock.acquire();
  const lockedDataDir = dataLock?.authorityPath ?? null;
  const transportOptions = dataLock === null
    ? options
    : {
        ...options,
        dataDir: dataLock.authorityPath,
        freshDataDirectory: dataLock.initializedNewDirectory
      };
  let transport: WorkerTransport;
  try {
    const outbox = options.outbox ?? (lockedDataDir === null
      ? null
      : new MutationOutbox(path.join(lockedDataDir, "mutation-outbox")));
    if (outbox !== null && options.outbox === undefined) await outbox.init();
    transport = new WorkerTransport(transportOptions, outbox);
    await transport.start();
  } catch (error) {
    await releaseOrRetainDataLock(dataLock, error);
    throw error;
  }
  const api = storyApiFromWorkerTransport(transport);
  let disposal: Promise<void> | null = null;
  const dispose = (): Promise<void> => {
    disposal ??= (async () => {
      try {
        await transport.dispose();
      } catch (error) {
        await releaseOrRetainDataLock(dataLock, error);
        throw error;
      }
      await dataLock?.release();
    })();
    return disposal;
  };
  return {
    api,
    recovery: transport.recovery,
    recoveryWarnings: transport.recoveryWarnings,
    failure: transport.failure,
    dispose
  };
}
