import { inlineValue, resolveExistingProject, separatedValue } from "./project-command.js";
import type { StorySummary } from "../../shared/types.js";
import { readImportBytes } from "../../server/import-file.js";
import { selectStory } from "./story-selector.js";
import { terminalLineText as plain } from "../../shared/terminal-text.js";
import { openProjectBackend } from "./vault-project-backend.js";
import { countNoun, fidelityReport } from "../../shared/fidelity.js";

export interface LorebookImportCommand {
  readonly story: string;
  readonly files: readonly string[];
  readonly data: string | null;
  readonly global: boolean;
  readonly passphraseFile: string | null;
}

export function parseLorebookImportCommand(argv: readonly string[]): LorebookImportCommand {
  const files: string[] = [];
  let story: string | null = null;
  let data: string | null = null;
  let global = false;
  let passphraseFile: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--global") global = true;
    else if (argument.startsWith("--passphrase-file=")) {
      passphraseFile = inlineValue(argument, "--passphrase-file");
    }
    else if (argument.startsWith("--story=")) story = inlineValue(argument, "--story");
    else if (argument.startsWith("--data=")) data = inlineValue(argument, "--data");
    else if (argument === "--story" || argument === "--data" || argument === "--passphrase-file") {
      const value = separatedValue(argv, ++index, argument);
      if (argument === "--story") story = value;
      else if (argument === "--data") data = value;
      else passphraseFile = value;
    } else if (argument.startsWith("-")) {
      throw new Error(`unknown import-lorebook option: ${plain(argument)}`);
    } else {
      files.push(argument);
    }
  }

  if (story === null) {
    throw new Error(
      "import-lorebook requires --story, because lorebook Facts join a story that already exists"
    );
  }
  if (files.length === 0) {
    throw new Error("import-lorebook requires at least one file argument");
  }
  if (global && data !== null) {
    throw new Error("--global and --data select different projects");
  }

  for (const file of files) {
    const lower = file.toLowerCase();
    if (lower.endsWith(".story")) {
      throw new Error("1667 import-lorebook imports Lorebooks (.lorebook), not story archives (.story); use 1667 import");
    }
    if (lower.endsWith(".scenario")) {
      throw new Error("1667 import-lorebook imports Lorebooks (.lorebook), not scenarios (.scenario); use 1667 import");
    }
  }

  return { story, files, data, global, passphraseFile };
}

export async function runLorebookImport(
  argv: readonly string[],
  output: Pick<NodeJS.WriteStream, "write"> = process.stdout,
  errorOutput: Pick<NodeJS.WriteStream, "write"> = process.stderr
): Promise<void> {
  const command = parseLorebookImportCommand(argv);
  const project = await resolveExistingProject(command, "import");
  const backend = await openProjectBackend(project, command.passphraseFile);
  let failed = false;

  try {
    const story = selectStory(await backend.api.listStories(), command.story);
    for (const file of command.files) {
      try {
        const bytes = await readImportBytes(file);
        const { payload: updatedPayload, importResult } = await backend.api.importLorebook(
          story.id,
          bytes
        );

        const importedCount = importResult.facts.length;

        errorOutput.write(`${plain(file)}: ${fidelityReport(importResult.fidelity)}\n`);
        output.write(
          `${plain(file)}: imported ${importedCount} ${countNoun(importedCount, "fact")} into "${plain(story.title)}"\n`
        );
      } catch (error) {
        failed = true;
        errorOutput.write(
          `${plain(file)}: ${plain(error instanceof Error ? error.message : String(error))}\n`
        );
      }
    }
  } finally {
    await backend.dispose();
  }

  if (failed) process.exitCode = 1;
}
