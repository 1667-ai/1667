import type { ResolvedProject } from "../../server/project-discovery.js";
import {
  createWorkerStoryApi,
  type WorkerStoryApi,
  type WorkerStoryApiOptions
} from "./worker-api.js";
import { readVaultPassphrase } from "./vault-passphrase.js";
import {
  isSealedVault,
  openSealedVaultWithPassword,
  revalidateSealedVault,
  revalidateUnsealedVault
} from "./vault-open.js";

export interface ProjectBackendDependencies {
  readonly createWorker?: (options: WorkerStoryApiOptions) => Promise<WorkerStoryApi>;
}

/** Open one command backend, prompting for a Vault Password only when needed. */
export async function openProjectBackend(
  project: ResolvedProject,
  passphraseFile: string | null,
  dependencies: ProjectBackendDependencies = {}
): Promise<WorkerStoryApi> {
  const createWorker = dependencies.createWorker ?? createWorkerStoryApi;
  if (!await isSealedVault(project.directory)) {
    return await createWorker({
      dataDir: project.directory,
      beforeVaultMigration: revalidateUnsealedVault
    });
  }
  const password = await readVaultPassphrase({
    passphraseFile,
    dataDirectory: project.directory,
    confirm: false
  });
  const vault = await openSealedVaultWithPassword(project.directory, password);
  if (vault === null) throw new Error("vault changed while reading the Vault Password; start again");
  return await createWorker({
    dataDir: project.directory,
    vaultKey: vault.key,
    beforeVaultMigration: async (lockedDataDirectory) => {
      await revalidateSealedVault(lockedDataDirectory, vault.keyslotBytes);
    }
  });
}
