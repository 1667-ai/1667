import path from "node:path";
import { readImportBytes } from "../server/import-file.js";
import type { StoryPayload } from "../shared/types.js";

export interface StoryImportResult {
  readonly file: string;
  readonly title: string;
  readonly partsCount: number;
  readonly factsCount: number | null;
  readonly id: string;
  /** Null means the source format has no fidelity report (Markdown). */
  readonly fidelity: readonly string[] | null;
}

export interface StoryImportApi {
  importSillyTavern(jsonl: string): Promise<StoryTransferResult>;
  importMarkdown(markdown: string, defaultTitle?: string): Promise<StoryPayload>;
  importNovelAI(storyContainerJson: string): Promise<StoryTransferResult>;
  importScenario(jsonText: string): Promise<StoryTransferResult>;
}

export interface StoryTransferResult {
  readonly payload: StoryPayload;
  readonly fidelity: readonly string[];
}

/** Read and import one story hand-off file. The caller chooses presentation. */
export async function importStoryFile(
  api: StoryImportApi,
  file: string
): Promise<StoryImportResult> {
  const content = await readImportText(file);
  const lowerFile = file.toLowerCase();
  const isStory = lowerFile.endsWith(".story");
  const isScenario = lowerFile.endsWith(".scenario");
  const isMarkdown = !isStory && !isScenario && (lowerFile.endsWith(".md")
    || (!lowerFile.endsWith(".jsonl") && content.trimStart().startsWith("#")));

  if (isStory) {
    const result = await api.importNovelAI(content);
    return importedResult(file, result.payload, result.fidelity);
  }
  if (isScenario) {
    const result = await api.importScenario(content);
    return importedResult(file, result.payload, result.fidelity);
  }
  if (isMarkdown) {
    const payload = await api.importMarkdown(
      content,
      path.basename(file, path.extname(file))
    );
    return importedResult(file, payload, null, null);
  }
  const result = await api.importSillyTavern(content);
  return importedResult(file, result.payload, result.fidelity, null);
}

export async function readImportText(file: string): Promise<string> {
  return new TextDecoder("utf-8").decode(await readImportBytes(file));
}

function importedResult(
  file: string,
  payload: StoryPayload,
  fidelity: readonly string[] | null,
  factsCount: number | null = payload.facts.length
): StoryImportResult {
  return {
    file,
    title: payload.title,
    partsCount: payload.nodes.length,
    factsCount,
    id: payload.id,
    fidelity
  };
}
