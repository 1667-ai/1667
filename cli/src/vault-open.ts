import {
  isSealedVault,
  openSealedVaultWithPassword,
  revalidateSealedVault,
  revalidateUnsealedVault,
  type OpenedVault
} from "../../host/launcher-vault-open.js";
import {
  canPromptForProject,
  promptVaultPassword,
  type ProjectPromptStreams
} from "./project-prompt.js";

export type { OpenedVault } from "../../host/launcher-vault-open.js";
export {
  isSealedVault,
  openSealedVaultWithPassword,
  revalidateSealedVault,
  revalidateUnsealedVault
};

/** Open a sealed vault with the terminal Vault Password prompt. */
export async function openSealedVault(
  dataDirectory: string,
  streams: ProjectPromptStreams = { input: process.stdin, output: process.stdout }
): Promise<OpenedVault | null> {
  if (!await isSealedVault(dataDirectory)) return null;
  if (!canPromptForProject(streams)) {
    throw new Error("a sealed vault requires a TTY Vault Password prompt");
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const password = await promptVaultPassword(streams);
    try {
      const opened = await openSealedVaultWithPassword(dataDirectory, password);
      if (opened !== null) return opened;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "Vault Password is incorrect") {
        throw error;
      }
      if (attempt < 2) streams.output.write("Incorrect Vault Password. Try again.\n");
    }
  }
  throw new Error("Vault Password failed three times");
}
