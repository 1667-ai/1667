import {
  resolveProject,
  type ProjectRequest
} from "../../server/project-discovery.js";
import { PROJECT_DIRECTORY_NAME } from "../../server/project-layout.js";
import { writeStoryExport } from "./export-file.js";
import { createWorkerStoryApi } from "./worker-api.js";

export interface ExportCommand {
  readonly storyId: string | null;
  readonly force: boolean;
  readonly data: string | null;
  readonly global: boolean;
}

export function parseExportCommand(argv: readonly string[]): ExportCommand {
  let storyId: string | null = null;
  let force = false;
  let data: string | null = null;
  let global = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--force") force = true;
    else if (argument === "--global") global = true;
    else if (argument.startsWith("--story=")) storyId = inlineValue(argument, "--story");
    else if (argument.startsWith("--data=")) data = inlineValue(argument, "--data");
    else if (argument === "--story" || argument === "--data") {
      const value = argv[++index];
      if (value === undefined || value.length === 0) {
        throw new Error(`${argument} requires a value`);
      }
      if (argument === "--story") storyId = value;
      else data = value;
    } else throw new Error(`unknown export option: ${argument}`);
  }
  if (global && data !== null) {
    throw new Error("--global and --data select different projects");
  }
  return { storyId, force, data, global };
}

/**
 * Write the selected story line of one story to the project root and
 * stop. Export registers no watcher and keeps no state, so this command has no
 * counterpart that reads the file back.
 */
export async function runStoryExport(
  argv: readonly string[],
  output: Pick<NodeJS.WriteStream, "write"> = process.stdout
): Promise<void> {
  const command = parseExportCommand(argv);
  const outcome = await resolveProject(projectRequest(command));
  if (outcome.kind === "absent") {
    throw new Error(
      `no ${PROJECT_DIRECTORY_NAME} story project in ${outcome.cwd} or any parent, `
        + "so there is nothing to export. Run '1667 init' first."
    );
  }
  const project = outcome.project;
  // Exporting a project that does not exist would create one and then export
  // the starter stories it had just invented.
  if (!project.exists) {
    throw new Error(
      `${project.directory} is not a 1667 story project yet, so there is `
        + "nothing to export. Run '1667 init' there first."
    );
  }
  const backend = await createWorkerStoryApi({ dataDir: project.directory });
  try {
    const stories = [...await backend.api.listStories()].sort(
      (left, right) => right.updatedAt.localeCompare(left.updatedAt)
    );
    const selected = command.storyId === null
      ? stories[0]
      : stories.find((story) => story.id === command.storyId);
    if (selected === undefined) {
      throw new Error(command.storyId === null
        ? `no stories to export in ${project.directory}`
        : `unknown story: ${command.storyId}`);
    }
    const file = await writeStoryExport({
      directory: project.root,
      title: selected.title,
      markdown: await backend.api.exportMarkdown(selected.id),
      force: command.force
    });
    output.write(`${file}\n`);
  } finally {
    await backend.dispose();
  }
}

function projectRequest(command: ExportCommand): ProjectRequest {
  return {
    cwd: process.cwd(),
    ...(command.data === null ? {} : { data: command.data }),
    ...(command.global ? { global: true } : {})
  };
}

function inlineValue(argument: string, flag: string): string {
  const value = argument.slice(flag.length + 1);
  if (value.length === 0) throw new Error(`${flag} requires a value`);
  return value;
}
