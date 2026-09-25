import { importStoryFile } from "../../host/launcher-import.js";
import { inlineValue, resolveExistingProject, separatedValue } from "./project-command.js";
import { terminalLineText as plain } from "../../shared/terminal-text.js";
import { openProjectBackend } from "./vault-project-backend.js";
import { fidelityReport } from "../../shared/fidelity.js";

export interface ImportCommand {
  readonly files: readonly string[];
  readonly data: string | null;
  readonly global: boolean;
  readonly passphraseFile: string | null;
}

export function parseImportCommand(argv: readonly string[]): ImportCommand {
  const files: string[] = [];
  let data: string | null = null;
  let global = false;
  let passphraseFile: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--global") global = true;
    else if (argument.startsWith("--passphrase-file=")) {
      passphraseFile = inlineValue(argument, "--passphrase-file");
    }
    else if (argument.startsWith("--data=")) data = inlineValue(argument, "--data");
    else if (argument === "--data" || argument === "--passphrase-file") {
      const value = separatedValue(argv, ++index, argument);
      if (argument === "--data") data = value;
      else passphraseFile = value;
    } else if (argument.startsWith("-")) {
      throw new Error(`unknown import option: ${plain(argument)}`);
    } else {
      files.push(argument);
    }
  }
  if (global && data !== null) throw new Error("--global and --data select different projects");
  if (files.length === 0) throw new Error("import requires at least one file argument");
  for (const file of files) {
    if (file.toLowerCase().endsWith(".lorebook")) {
      throw new Error("1667 import creates stories, not Lorebooks (.lorebook); use 1667 import-lorebook");
    }
  }
  return { files, data, global, passphraseFile };
}

export async function runStoryImport(
  argv: readonly string[],
  output: Pick<NodeJS.WriteStream, "write"> = process.stdout,
  errorOutput: Pick<NodeJS.WriteStream, "write"> = process.stderr
): Promise<void> {
  const command = parseImportCommand(argv);
  const project = await resolveExistingProject(command, "import");
  const backend = await openProjectBackend(project, command.passphraseFile);
  let failed = false;
  try {
    for (const file of command.files) {
      try {
        const result = await importStoryFile(backend.api, file);
        if (result.fidelity !== null) {
          errorOutput.write(`${plain(file)}: ${fidelityReport(result.fidelity)}\n`);
        }
        output.write(
          `${plain(file)}: imported "${plain(result.title)}" (${result.partsCount} parts`
            + `${result.factsCount === null ? "" : `, ${result.factsCount} facts`}) as ${result.id}\n`
        );
      } catch (error) {
        failed = true;
        errorOutput.write(`${plain(file)}: ${plain(error instanceof Error ? error.message : String(error))}\n`);
      }
    }
  } finally {
    await backend.dispose();
  }
  if (failed) process.exitCode = 1;
}
