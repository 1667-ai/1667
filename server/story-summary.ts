import { activePath, hasFork, isChapterSummary, leafCount } from "../shared/story-tree.js";
import type { Story, StorySummary } from "../shared/types.js";
import { countWords } from "./story-codec.js";
import type {
  StoryManifestV4,
  StoryManifestV5,
  StoryManifestV7,
  StoryManifestV9
} from "./story-format.js";

export function buildStorySummary(
  source: Story | StoryManifestV4 | StoryManifestV5 | StoryManifestV7 | StoryManifestV9
): StorySummary {
  if ("schemaVersion" in source) {
    const path = activePath(source);
    return {
      id: source.id,
      title: source.title,
      updatedAt: source.updatedAt,
      partCount: path.length,
      words: source.activeWordCount,
      forked: hasFork(source),
      lineCount: leafCount(source)
    };
  }
  const path = activePath(source);
  return {
    id: source.id,
    title: source.title,
    updatedAt: source.updatedAt,
    partCount: path.length,
    words: path.reduce((sum, node) => sum + countWords(node.text), 0),
    forked: hasFork(source),
    lineCount: leafCount(source)
  };
}

/** Build the summary shown by story catalogs. The persisted summary keeps
 * the active-line word count for format compatibility. Catalogs show the
 * words stored across all prose branches. */
export function buildStoryCatalogSummary(
  source: Story | StoryManifestV4 | StoryManifestV5 | StoryManifestV7 | StoryManifestV9
): StorySummary {
  return {
    ...buildStorySummary(source),
    words: catalogWordCount(source)
  };
}

function catalogWordCount(
  source: Story | StoryManifestV4 | StoryManifestV5 | StoryManifestV7 | StoryManifestV9
): number {
  if (!("schemaVersion" in source)) {
    return source.nodes.reduce(
      (sum, node) => sum + (isChapterSummary(node) ? 0 : countWords(node.text)),
      0
    );
  }

  let words = 0;
  for (const node of source.nodes) {
    if (isChapterSummary(node)) continue;
    // Early V4 manifests did not store per-node word metadata. Keep their
    // valid active-line count until the next ordinary save populates it.
    if (node.words === undefined) return source.activeWordCount;
    words += node.words;
  }
  return words;
}
