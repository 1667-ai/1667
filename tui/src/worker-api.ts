import { createWorkerHost } from "../../host/worker-host.js";
import { storyApiFromWorkerTransport } from "../../client/worker-story-api.js";
import type {
  WorkerStoryApi,
  WorkerStoryApiOptions
} from "./worker-api-contract.js";

export { WorkerExitUnconfirmedError } from "../../host/worker-data-lock.js";
export {
  BACKEND_RESTART_REQUIRED_EXIT_CODE,
  BackendRestartRequiredError,
  exitForBackendRestart,
  WorkerApiError,
  workerApiErrorFromFailure
} from "../../host/worker-error.js";
export type {
  WorkerRecoveryWarning,
  WorkerStoryApi,
  WorkerStoryApiOptions
} from "./worker-api-contract.js";

/** Compose the TUI facade over the shared embedded Worker host. */
export async function createWorkerStoryApi(
  options: WorkerStoryApiOptions = {}
): Promise<WorkerStoryApi> {
  const host = await createWorkerHost(options);
  return {
    api: storyApiFromWorkerTransport(host.transport),
    recovery: host.recovery,
    recoveryWarnings: host.recoveryWarnings,
    failure: host.failure,
    dispose: host.dispose
  };
}
