import path from "node:path";
import { resolveDataDirectory } from "../../server/data-directory.js";
import { resolveDiagnosticMachineTier } from "../../server/diagnostic-machine-tier.js";
import { MutationOutbox } from "../../server/mutation-outbox.js";
import { RuntimeDataDirectoryLock } from "../../server/runtime-data-directory.js";
import { releaseOrRetainDataLock } from "./worker-data-lock.js";
import { storyApiFromWorkerTransport } from "./worker-story-api.js";
import { WorkerTransport } from "./worker-transport.js";
import type { WorkerStoryApi, WorkerStoryApiOptions } from "./worker-api-contract.js";
import { reportEmbeddedWorkerHostFailure } from "./worker-host-diagnostics.js";
import { BackendRestartRequiredError } from "./worker-error.js";
import {
  registerVaultKey,
  type VaultKeyRegistration
} from "../../server/vault-key-registry.js";

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
  const vault = { registration: null as VaultKeyRegistration | null };
  const clearVaultRegistration = (): void => {
    const registration = vault.registration;
    vault.registration = null;
    registration?.clear();
  };
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
  if (dataLock !== null) {
    try {
      await dataLock.acquire({
        beforeMigration: async (lockedDataDirectory) => {
          await options.beforeVaultMigration?.(lockedDataDirectory);
          if (options.vaultKey !== undefined) {
            vault.registration = registerVaultKey(lockedDataDirectory, options.vaultKey);
          }
        }
      });
    } catch (error) {
      clearVaultRegistration();
      throw error;
    }
  }
  let lockedDataDir: string | null = null;
  let transportOptions: WorkerStoryApiOptions = options;
  let transport: WorkerTransport;
  let failureReport: Promise<Error> | null = null;
  const reportFailure = (error: Error): Promise<Error> => {
    if (!(error instanceof BackendRestartRequiredError)
      || error.diagnosticRef !== null) {
      return Promise.resolve(error);
    }
    failureReport ??= reportEmbeddedWorkerHostFailure(
      error,
      transportOptions.machineDir,
      options.printLogs === true
    );
    return failureReport;
  };
  try {
    lockedDataDir = dataLock?.authorityPath ?? null;
    if (lockedDataDir !== null) vault.registration?.addAlias(lockedDataDir);
    if (dataLock === null) {
      transportOptions = options;
    } else {
      if (lockedDataDir === null) throw new Error("Data-directory authority is unavailable after acquisition");
      transportOptions = {
        ...options,
        dataDir: lockedDataDir,
        freshDataDirectory: dataLock.initializedNewDirectory
      };
    }
    const outbox = options.outbox ?? (lockedDataDir === null
      ? null
      : new MutationOutbox(path.join(lockedDataDir, "mutation-outbox")));
    if (outbox !== null && options.outbox === undefined) await outbox.init();
    transport = new WorkerTransport(transportOptions, outbox);
    await transport.start();
  } catch (error) {
    let terminal: unknown = error;
    try {
      if (error instanceof Error) terminal = await reportFailure(error);
    } catch (reportError) {
      terminal = reportError;
    }
    try {
      await releaseOrRetainDataLock(dataLock, terminal);
    } finally {
      clearVaultRegistration();
    }
    throw terminal;
  }
  const api = storyApiFromWorkerTransport(transport);
  const failure = transport.failure.then(reportFailure);
  let disposal: Promise<void> | null = null;
  const dispose = (): Promise<void> => {
    disposal ??= (async () => {
      try {
        await transport.dispose();
      } catch (error) {
        let terminal: unknown = error;
        try {
          if (error instanceof Error) terminal = await reportFailure(error);
        } catch (reportError) {
          terminal = reportError;
        }
        try {
          await releaseOrRetainDataLock(dataLock, terminal);
        } finally {
          clearVaultRegistration();
        }
        throw terminal;
      }
      try {
        await dataLock?.release();
      } finally {
        clearVaultRegistration();
      }
    })();
    return disposal;
  };
  return {
    api,
    recovery: transport.recovery,
    recoveryWarnings: transport.recoveryWarnings,
    failure,
    dispose
  };
}
