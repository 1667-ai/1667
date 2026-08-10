import { readFile } from "node:fs/promises";
import { unsealVaultFileForPath } from "./vault-key-registry.js";

/** Read project bytes and unseal them when their data directory is open. */
export async function readUnsealedFile(file: string): Promise<Buffer> {
  return unsealVaultFileForPath(file, await readFile(file));
}
