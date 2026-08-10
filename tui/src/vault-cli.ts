import {
  decryptVault,
  encryptVault
} from "../../server/vault-lifecycle.js";
import { inlineValue, resolveExistingProject, separatedValue } from "./project-command.js";
import { readVaultPassphrase } from "./vault-passphrase.js";

export interface VaultCommand {
  readonly passphraseFile: string | null;
  readonly data: string | null;
  readonly global: boolean;
}

export function parseVaultCommand(argv: readonly string[]): VaultCommand {
  let passphraseFile: string | null = null;
  let data: string | null = null;
  let global = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--global") global = true;
    else if (argument.startsWith("--data=")) data = inlineValue(argument, "--data");
    else if (argument.startsWith("--passphrase-file=")) {
      passphraseFile = inlineValue(argument, "--passphrase-file");
    } else if (argument === "--data" || argument === "--passphrase-file") {
      const value = separatedValue(argv, ++index, argument);
      if (argument === "--data") data = value;
      else passphraseFile = value;
    } else throw new Error(`unknown vault option: ${argument}`);
  }
  if (global && data !== null) throw new Error("--global and --data select different projects");
  return { passphraseFile, data, global };
}

export async function runVaultEncrypt(
  argv: readonly string[],
  errorOutput: Pick<NodeJS.WriteStream, "write"> = process.stderr
): Promise<void> {
  const command = parseVaultCommand(argv);
  const project = await resolveExistingProject(command, "encrypt");
  await encryptVault({
    dataDirectory: project.directory,
    password: async ({ resume }) => {
      if (!resume) {
        errorOutput.write(
          "Warning: a lost Vault Password cannot be recovered. Copies from before this run, "
          + "including snapshots, sync history, backups, and freed blocks, can stay plaintext.\n"
        );
      }
      return await readVaultPassphrase({
        passphraseFile: command.passphraseFile,
        dataDirectory: project.directory,
        confirm: !resume
      });
    }
  });
}

export async function runVaultDecrypt(argv: readonly string[]): Promise<void> {
  const command = parseVaultCommand(argv);
  const project = await resolveExistingProject(command, "decrypt");
  await decryptVault({
    dataDirectory: project.directory,
    password: async () => await readVaultPassphrase({
      passphraseFile: command.passphraseFile,
      dataDirectory: project.directory,
      confirm: false
    })
  });
}
