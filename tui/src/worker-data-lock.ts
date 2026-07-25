import { RuntimeDataDirectoryLock } from "../../server/runtime-data-directory.js";
import { BackendRestartRequiredError } from "./worker-error.js";

const retainedDataLocks = new Set<RuntimeDataDirectoryLock>();

export class WorkerExitUnconfirmedError extends Error {
  constructor() {
    super("Embedded backend worker exit was not confirmed; data lock remains held for process safety");
    this.name = "WorkerExitUnconfirmedError";
  }
}

export async function releaseOrRetainDataLock(
  dataLock: RuntimeDataDirectoryLock | null,
  error: unknown
): Promise<void> {
  if (dataLock === null) return;
  if (error instanceof WorkerExitUnconfirmedError || error instanceof BackendRestartRequiredError) {
    retainedDataLocks.add(dataLock);
    return;
  }
  await dataLock.release();
}
