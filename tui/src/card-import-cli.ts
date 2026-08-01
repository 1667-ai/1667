import { inlineValue, resolveImportProject, separatedValue } from "./import-project.js";
import type { StorySummary } from "../../shared/types.js";
import { planCardImport } from "./card-import.js";
import { readImportBytes } from "./import-file.js";
import { plainTerminalText as plain } from "../../shared/terminal-text.js";
import { createWorkerStoryApi } from "./worker-api.js";

export interface CardImportCommand {
  readonly story: string;
  readonly files: readonly string[];
  readonly data: string | null;
  readonly global: boolean;
}

export function parseCardImportCommand(argv: readonly string[]): CardImportCommand {
  const files: string[] = [];
  let story: string | null = null;
  let data: string | null = null;
  let global = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--global") global = true;
    else if (argument.startsWith("--story=")) story = inlineValue(argument, "--story");
    else if (argument.startsWith("--data=")) data = inlineValue(argument, "--data");
    else if (argument === "--story" || argument === "--data") {
      const value = separatedValue(argv, ++index, argument);
      if (argument === "--story") story = value;
      else data = value;
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
  return { story, files, data, global };
}

export async function runCardImport(
  argv: readonly string[],
  output: Pick<NodeJS.WriteStream, "write"> = process.stdout,
  errorOutput: Pick<NodeJS.WriteStream, "write"> = process.stderr
): Promise<void> {
  const command = parseCardImportCommand(argv);
  const project = await resolveImportProject(command);
  const backend = await createWorkerStoryApi({ dataDir: project.directory });
  let failed = false;
  try {
    const story = selectStory(await backend.api.listStories(), command.story);
    for (const file of command.files) {
      try {
        const plan = planCardImport(await readImportBytes(file));
        await backend.api.createFact(story.id, { facts: [...plan.facts] });
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

function selectStory(stories: readonly StorySummary[], value: string): StorySummary {
  const byId = stories.find((story) => story.id === value);
  if (byId !== undefined) return byId;

  const exactTitles = stories.filter((story) => story.title === value);
  if (exactTitles.length > 0) return oneStoryTitleMatch(value, exactTitles);

  const foldedValue = value.toLowerCase();
  const foldedTitles = stories.filter((story) => story.title.toLowerCase() === foldedValue);
  if (foldedTitles.length > 0) return oneStoryTitleMatch(value, foldedTitles);

  throw new Error(`unknown story: ${plain(value)}`);
}

function oneStoryTitleMatch(value: string, matches: readonly StorySummary[]): StorySummary {
  if (matches.length === 1) return matches[0]!;
  throw new Error(
    `more than one story has the name "${plain(value)}"; use the story id `
      + `(${matches.map((story) => story.id).join(", ")})`
  );
}


