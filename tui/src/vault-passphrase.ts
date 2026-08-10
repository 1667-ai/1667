import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promptVaultPassword } from "./project-prompt.js";

export interface VaultPassphraseOptions {
  readonly passphraseFile: string | null;
  readonly dataDirectory: string;
  readonly confirm: boolean;
  readonly input?: NodeJS.ReadStream;
  readonly output?: NodeJS.WriteStream;
}

/** Read one non-empty Vault Password without putting it in argv or output. */
export async function readVaultPassphrase(options: VaultPassphraseOptions): Promise<string> {
  if (options.passphraseFile !== null) {
    const passphrase = await readPassphraseFile(options.passphraseFile, options.dataDirectory);
    requirePassphrase(passphrase);
    return passphrase;
  }
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  if (input.isTTY !== true || output.isTTY !== true) {
    throw new Error("a non-interactive vault command requires --passphrase-file <path>");
  }
  const streams = { input, output };
  const first = await promptVaultPassword(streams, "Vault Password: ");
  requirePassphrase(first);
  if (!options.confirm) return first;
  const second = await promptVaultPassword(streams, "Confirm Vault Password: ");
  if (first !== second) throw new Error("Vault Password entries do not match");
  return first;
}

async function readPassphraseFile(file: string, dataDirectory: string): Promise<string> {
  const resolvedFile = await realpath(file);
  const resolvedDataDirectory = await realpath(dataDirectory);
  if (resolvedFile === resolvedDataDirectory
    || resolvedFile.startsWith(`${resolvedDataDirectory}${path.sep}`)) {
    throw new Error("--passphrase-file must be outside the data directory");
  }
  const bytes = await readFile(resolvedFile);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return text.endsWith("\r\n") ? text.slice(0, -2) : text.endsWith("\n") ? text.slice(0, -1) : text;
}

function requirePassphrase(value: string): void {
  if (value.length === 0) throw new Error("Vault Password must not be empty");
}
