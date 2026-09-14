import type { MutationOutbox } from "../server/mutation-outbox.js";
import type { WorkerApiError } from "./worker-error.js";
import type { WorkerLike } from "./worker-lifecycle.js";
import type { RecoveryWarning } from "./worker-recovery.js";

export type WorkerRecoveryWarning = RecoveryWarning<WorkerApiError>;

/** Options for an embedded Worker host and its transport. */
export interface WorkerHostOptions {
  worker?: WorkerLike;
  /** Injectable durable store used by transport lifecycle tests. */
  outbox?: MutationOutbox;
  dataDir?: string;
  /** Advisory name for the project lock owner. */
  projectOwner?: "desktop";
  /** The machine tier, resolved before spawning a default worker. */
  machineDir?: string;
  /** Set by the lock owner when startup created the data directory. */
  freshDataDirectory?: boolean;
  /** Vault key held only by the opening process and its worker. */
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

/** Compatibility name used by the TUI composition layer. */
export type WorkerStoryApiOptions = WorkerHostOptions;
