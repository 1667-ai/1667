import { activePath, hasFork, leafCount } from "../shared/story-tree.js";
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
