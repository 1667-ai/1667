import { inlineValue, resolveExistingProject, separatedValue } from "./project-command.js";
import type { StorySummary } from "../../shared/types.js";
import { readImportBytes } from "../../server/import-file.js";
import { selectStory } from "./story-selector.js";
import { terminalLineText as plain } from "../../shared/terminal-text.js";
import { openProjectBackend } from "./vault-project-backend.js";
import { fidelityReport } from "../../shared/fidelity.js";

export interface CardImportCommand {
  readonly story: string;
  readonly files: readonly string[];
  readonly data: string | null;
  readonly global: boolean;
  readonly passphraseFile: string | null;
}

export function parseCardImportCommand(argv: readonly string[]): CardImportCommand {
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
      throw new Error(`unknown import-card option: ${plain(argument)}`);
    } else {
      files.push(argument);
    }
  }
  if (story === null) {
    throw new Error(
      "import-card requires --story, because card Facts join a story that already exists"
    );
  }
  if (files.length === 0) {
    throw new Error("import-card requires at least one file argument");
  }
  if (global && data !== null) {
    throw new Error("--global and --data select different projects");
  }
  return { story, files, data, global, passphraseFile };
}

export async function runCardImport(
  argv: readonly string[],
  output: Pick<NodeJS.WriteStream, "write"> = process.stdout,
  errorOutput: Pick<NodeJS.WriteStream, "write"> = process.stderr
): Promise<void> {
  const command = parseCardImportCommand(argv);
  const project = await resolveExistingProject(command, "import");
  const backend = await openProjectBackend(project, command.passphraseFile);
  let failed = false;
  try {
    const story = selectStory(await backend.api.listStories(), command.story);
    for (const file of command.files) {
      try {
        const bytes = await readImportBytes(file);
        // The service loads the story and computes its own room, fresh for
        // each file, the same way `importLorebook` does — an earlier file in
        // this same run can already have used up the story's space.
        const { plan } = await backend.api.importCard(story.id, bytes);
        errorOutput.write(`${plain(file)}: ${fidelityReport(plan.fidelity)}\n`);
        const skipped = plan.skipped.length === 0
          ? ""
          : `; skipped ${plan.skipped.join(", ")}`;
        output.write(
          `${plain(file)}: imported ${plan.facts.length} `
            + `${plan.facts.length === 1 ? "fact" : "facts"} for `
            + `"${plain(plan.name)}" into "${plain(story.title)}" — `
            + `used ${plan.used.join(", ")}${skipped}\n`
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
