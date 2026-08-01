import {
  resolveProject,
  type ProjectRequest
} from "../../server/project-discovery.js";
import { PROJECT_DIRECTORY_NAME } from "../../server/project-layout.js";
import {
  exportNovelAiArchive,
  type NovelAiExportFormat
} from "../../server/novelai-export.js";
import {
  createExportFileAllocator,
  writeExportFile,
  writeStoryExport
} from "./export-file.js";
import { createWorkerStoryApi } from "./worker-api.js";
import { fidelityReport } from "../../shared/fidelity.js";

export type ExportFormat = "markdown" | NovelAiExportFormat;

export interface ExportCommand {
  readonly storyId: string | null;
  readonly all: boolean;
  readonly format: ExportFormat;
  readonly force: boolean;
  readonly data: string | null;
  readonly global: boolean;
}

export function parseExportCommand(argv: readonly string[]): ExportCommand {
  let storyId: string | null = null;
  let all = false;
  let format: ExportFormat = "markdown";
  let force = false;
  let data: string | null = null;
  let global = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--force") force = true;
    else if (argument === "--all") all = true;
    else if (argument === "--global") global = true;
    else if (argument.startsWith("--story=")) storyId = inlineValue(argument, "--story");
    else if (argument.startsWith("--data=")) data = inlineValue(argument, "--data");
    else if (argument.startsWith("--format=")) format = archiveFormat(inlineValue(argument, "--format"));
    else if (argument === "--story" || argument === "--data" || argument === "--format") {
      const value = argv[++index];
      if (value === undefined || value.length === 0 || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      if (argument === "--story") storyId = value;
      else if (argument === "--data") data = value;
      else format = archiveFormat(value);
    } else throw new Error(`unknown export option: ${argument}`);
  }
  if (global && data !== null) {
    throw new Error("--global and --data select different projects");
  }
  if (all && storyId !== null) {
    throw new Error("--story and --all select different stories");
  }
  return { storyId, all, format, force, data, global };
}

/**
 * Write one selected story line, or every story, to the project root and stop.
 * Export registers no watcher and keeps no state, so this command has no
 * counterpart that reads the file back.
 */
export async function runStoryExport(
  argv: readonly string[],
  output: Pick<NodeJS.WriteStream, "write"> = process.stdout,
  errorOutput: Pick<NodeJS.WriteStream, "write"> = process.stderr
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
      (left, right) => compareStoriesForExport(left, right)
    );
    const singleStory = command.storyId === null
      ? stories[0]
      : stories.find((story) => story.id === command.storyId);
    const selected = command.all
      ? stories
      : singleStory === undefined ? [] : [singleStory];
    if (selected.length === 0) {
      throw new Error(command.storyId === null
        ? `no stories to export in ${project.directory}`
        : `unknown story: ${command.storyId}`);
    }
    const authorBrief = command.format === "markdown"
      ? ""
      : (await backend.api.getSettings()).effective.systemPrompt;
    const batchNames = command.all ? createExportFileAllocator() : null;
    for (const story of selected) {
      if (command.format === "markdown") {
        const file = await writeStoryExport({
          directory: project.root,
          title: story.title,
          markdown: await backend.api.exportMarkdown(story.id),
          force: command.force,
          ...(batchNames === null ? {} : {
            collisionIndex: batchNames.allocate(story.title, ".md")
          })
        });
        output.write(`${file}\n`);
        continue;
      }
      const archive = exportNovelAiArchive(
        await backend.api.loadStory(story.id),
        authorBrief,
        command.format
      );
      const file = await writeExportFile({
        directory: project.root,
        title: story.title,
        extension: archive.extension,
        content: archive.text,
        force: command.force,
        ...(batchNames === null ? {} : {
          collisionIndex: batchNames.allocate(story.title, archive.extension)
        })
      });
      output.write(`${file}\n`);
      errorOutput.write(`${file}: ${fidelityReport(archive.fidelity)}\n`);
    }
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

function archiveFormat(value: string): NovelAiExportFormat {
  if (value === "story" || value === "scenario" || value === "lorebook") return value;
  throw new Error(`unknown export format: ${value}`);
}


function compareStoriesForExport(
  left: { readonly updatedAt: string; readonly id: string },
  right: { readonly updatedAt: string; readonly id: string }
): number {
  if (left.updatedAt !== right.updatedAt) {
    return left.updatedAt < right.updatedAt ? 1 : -1;
  }
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}
