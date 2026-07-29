import type { NpmTagRegistry } from "./release-npm-operations.js";

class BeforeWriter {
  readonly phase = "before-writer";

  writerAcquired(): WriterAcquired {
    return new WriterAcquired();
  }
}

class WriterAcquired {
  readonly phase = "writer-acquired";

  registryReady(registry: NpmTagRegistry): RegistryReady {
    return new RegistryReady(registry);
  }
}

class RegistryReady {
  readonly phase = "registry-ready";
  readonly registry: NpmTagRegistry;

  constructor(registry: NpmTagRegistry) {
    this.registry = registry;
  }

  journalCompleted(): JournalCompleted {
    return new JournalCompleted();
  }
}

class JournalCompleted {
  readonly phase = "journal-completed";
}

export type NpmTagOperationLifecycle =
  | BeforeWriter
  | WriterAcquired
  | RegistryReady
  | JournalCompleted;

export interface NpmTagOperationRecovery {
  readonly recordFailureBeforeRegistry: (error: unknown) => Promise<void>;
  readonly recordFailureAfterRegistry: (
    error: unknown,
    registry: NpmTagRegistry
  ) => Promise<void>;
  readonly acknowledgeFailure: () => Promise<void>;
  readonly failLease: () => Promise<void>;
}

export function startNpmTagOperationLifecycle(): BeforeWriter {
  return new BeforeWriter();
}

export async function recoverNpmTagOperation(
  lifecycle: NpmTagOperationLifecycle,
  error: unknown,
  recovery: NpmTagOperationRecovery
): Promise<never> {
  switch (lifecycle.phase) {
    case "before-writer":
    case "journal-completed":
      throw error;
    case "writer-acquired":
      await recoveryStep(
        error,
        () => recovery.recordFailureBeforeRegistry(error)
      );
      break;
    case "registry-ready":
      await recoveryStep(
        error,
        () => recovery.recordFailureAfterRegistry(error, lifecycle.registry)
      );
      break;
  }
  await recoveryStep(error, recovery.acknowledgeFailure);
  try {
    await recovery.failLease();
  } catch (leaseError) {
    throw incompleteRecovery(error, leaseError);
  }
  throw error;
}

async function recoveryStep(
  operationError: unknown,
  step: () => Promise<void>
): Promise<void> {
  try {
    await step();
  } catch (recoveryError) {
    throw incompleteRecovery(operationError, recoveryError);
  }
}

function incompleteRecovery(
  operationError: unknown,
  recoveryError: unknown
): AggregateError {
  return new AggregateError(
    [operationError, recoveryError],
    "npm tag operation failed and its recovery records are incomplete"
  );
}
