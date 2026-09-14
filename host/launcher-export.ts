import {
  exportNovelAiArchive,
  type NovelAiExportFormat
} from "../server/novelai-export.js";
import type {
  StoryMarkdownExport,
  StoryPayload,
  StorySummary
} from "../shared/types.js";
import {
  createExportFileAllocator,
  writeExportFile,
  writeStoryExport
} from "./launcher/export-file.js";

export type ExportFormat = "markdown" | NovelAiExportFormat;

/** The API surface used by story export. */
export interface StoryExportApi {
  listStories(): Promise<readonly StorySummary[]>;
  exportMarkdown(storyId: string): Promise<StoryMarkdownExport>;
  loadStory(storyId: string): Promise<StoryPayload>;
}

export interface StoryExportRequest {
  readonly api: StoryExportApi;
  readonly directory: string;
  /** Path shown when the selected project has no stories. */
  readonly errorDirectory?: string;
  readonly storyId: string | null;
  readonly all: boolean;
  readonly format: ExportFormat;
  readonly force: boolean;
  readonly onResult?: (result: StoryExportResult) => void | Promise<void>;
}

export interface StoryExportResult {
  readonly storyId: string;
  readonly file: string;
  readonly fidelity: readonly string[];
}

/** Export one selected story or every story. The caller owns project opening. */
export async function exportStories(
  request: StoryExportRequest
): Promise<readonly StoryExportResult[]> {
  const stories = [...await request.api.listStories()].sort(compareStoriesForExport);
  const singleStory = request.storyId === null
    ? stories[0]
    : stories.find((story) => story.id === request.storyId);
  const selected = request.all
    ? stories
    : singleStory === undefined ? [] : [singleStory];
  if (selected.length === 0) {
    throw new Error(request.storyId === null
      ? `no stories to export in ${request.errorDirectory ?? request.directory}`
      : `unknown story: ${request.storyId}`);
  }

  const batchNames = request.all ? createExportFileAllocator() : null;
  const results: StoryExportResult[] = [];
  for (const story of selected) {
    if (request.format === "markdown") {
      const exported = await request.api.exportMarkdown(story.id);
      const file = await writeStoryExport({
        directory: request.directory,
        title: story.title,
        markdown: exported.markdown,
        force: request.force,
        ...(batchNames === null ? {} : {
          collisionIndex: batchNames.allocate(story.title, ".md")
        })
      });
      const result = { storyId: story.id, file, fidelity: exported.fidelity };
      results.push(result);
      await request.onResult?.(result);
      continue;
    }

    const archive = exportNovelAiArchive(
      await request.api.loadStory(story.id),
      request.format
    );
    const file = await writeExportFile({
      directory: request.directory,
      title: story.title,
      extension: archive.extension,
      content: archive.text,
      force: request.force,
      ...(batchNames === null ? {} : {
        collisionIndex: batchNames.allocate(story.title, archive.extension)
      })
    });
    const result = { storyId: story.id, file, fidelity: archive.fidelity };
    results.push(result);
    await request.onResult?.(result);
  }
  return results;
}

function compareStoriesForExport(
  left: Pick<StorySummary, "updatedAt" | "id">,
  right: Pick<StorySummary, "updatedAt" | "id">
): number {
  if (left.updatedAt !== right.updatedAt) {
    return left.updatedAt < right.updatedAt ? 1 : -1;
  }
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}
