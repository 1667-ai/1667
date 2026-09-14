import type { StoryApi } from "./api.js";
import type {
  WorkerHostOptions,
  WorkerRecoveryWarning as HostWorkerRecoveryWarning
} from "../../host/worker-api-contract.js";

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

export type WorkerRecoveryWarning = HostWorkerRecoveryWarning;
export type WorkerStoryApiOptions = WorkerHostOptions;
