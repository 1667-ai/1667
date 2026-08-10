import type { MutationOutbox } from "../../server/mutation-outbox.js";
import type { StoryApi } from "./api.js";
import type { WorkerApiError } from "./worker-error.js";
import type { WorkerLike } from "./worker-lifecycle.js";
import type { RecoveryWarning } from "./worker-recovery.js";

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

export type WorkerRecoveryWarning = RecoveryWarning<WorkerApiError>;

export interface WorkerStoryApiOptions {
  worker?: WorkerLike;
  /** Injectable durable store used by transport lifecycle tests. */
  outbox?: MutationOutbox;
  dataDir?: string;
  /** The machine tier, resolved by createWorkerStoryApi when it spawns a
   * worker so an unavailable one is reported before the backend starts. */
  machineDir?: string;
  /** Set by the lock owner when startup created the data directory. */
  freshDataDirectory?: boolean;
  /** Vault Key held only by the opening process and its worker. */
  vaultKey?: Uint8Array;
  /** Revalidates a sealed vault after this process owns its lock. */
  beforeVaultMigration?: (lockedDataDirectory: string) => Promise<void>;
  /** Echo unexpected embedded errors to stderr as well as the private log. */
  printLogs?: boolean;
  readyTimeoutMs?: number;
  startupTimeoutMs?: number;
  unaryTimeoutMs?: number;
  mutationDeadlineMs?: number;
  streamDeadlineMs?: number;
  shutdownGraceMs?: number;
  terminationConfirmMs?: number;
  cancelGraceMs?: number;
  /** Publishes retained mutation warnings to the interactive recovery owner. */
  onRecoveryWarnings?: (
    warnings: readonly WorkerRecoveryWarning[]
  ) => boolean | void;
}
