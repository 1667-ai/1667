import {
  decryptVault,
  encryptVault,
  type VaultPasswordProvider
} from "../server/vault-lifecycle.js";

export type VaultPassword = VaultPasswordProvider;

/** Encrypt one project with a caller-owned password source. */
export async function encryptProjectVault(
  dataDirectory: string,
  password: VaultPassword
): Promise<void> {
  await encryptVault({ dataDirectory, password });
}

/** Decrypt one project with a caller-owned password source. */
export async function decryptProjectVault(
  dataDirectory: string,
  password: VaultPassword
): Promise<void> {
  await decryptVault({
    dataDirectory,
    password
  });
}
