import { createWorkerHost } from "./worker-host.js";
import { storyApiFromWorkerTransport } from "../client/worker-story-api.js";
import type { StoryApi } from "../client/api.js";
import type {
  WorkerRecoveryWarning,
  WorkerStoryApiOptions
} from "./worker-api-contract.js";

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
  WorkerStoryApiOptions
} from "./worker-api-contract.js";

/** A story API composed over the embedded Worker host, for the CLI and TUI. */
export interface WorkerStoryApi {
  api: StoryApi;
  /** Settles after background replay has classified every startup intent. */
  readonly recovery: Promise<readonly WorkerRecoveryWarning[]>;
  /** Populated as background replay results arrive. */
  readonly recoveryWarnings: readonly WorkerRecoveryWarning[];
  /** Resolves only when the one-shot worker dies unexpectedly. */
  failure: Promise<Error>;
  dispose(): Promise<void>;
}

/** Compose the embedded Worker host into the story API surface the CLI opens. */
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
