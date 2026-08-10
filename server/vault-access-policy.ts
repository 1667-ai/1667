import { readDataDirectoryFormat } from "./data-directory-format.js";
import { PublicRuntimeError } from "./errors.js";

/** HTTP transports never receive a Vault Key, so they must refuse sealed vaults. */
export async function refuseSealedVaultForHttp(
  dataDirectory: string,
  operation: string
): Promise<void> {
  try {
    if (await readDataDirectoryFormat(dataDirectory) === 5) {
      throw new PublicRuntimeError(
        `${operation} cannot open a sealed vault; use the TUI or an offline command with --passphrase-file`
      );
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}
