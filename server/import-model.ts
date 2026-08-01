import { randomUUID } from "node:crypto";
import type { ChapterBreak, Story, StoryNode } from "../shared/types.js";

export { MAX_IMPORT_BYTES } from "../shared/types.js";

export interface ImportedPart {
  instruction: string;
  text: string;
  createdAt: string;
}

export interface GenericImport {
  title: string;
  parts: ImportedPart[];
  chapterBreaks?: readonly { parentPartIndex: number; title: string }[];
}

export const MAX_PARTS = 5_000;
/** Cumulative characters in the story written to disk. */
export const MAX_TOTAL_CHARS = 4_000_000;

export function storyFromImport(
  imported: GenericImport,
  ids: {
    storyId?: string;
    nodeId?: (index: number) => string;
    chapterBreakId?: (index: number) => string;
  } = {}
): Story {
  const now = new Date().toISOString();
  const nodes: StoryNode[] = imported.parts.map((part, index) => ({
    id: ids.nodeId?.(index) ?? randomUUID(),
    parentId: index === 0 ? null : "",
    model: "imported",
    ...part,
    activeChildId: null
  }));
  for (let index = 0; index < nodes.length; index += 1) {
    if (index > 0) nodes[index]!.parentId = nodes[index - 1]!.id;
    nodes[index]!.activeChildId = nodes[index + 1]?.id ?? null;
  }
  const chapterBreaks: ChapterBreak[] = (imported.chapterBreaks ?? []).map((b, index) => ({
    id: ids.chapterBreakId?.(index) ?? randomUUID(),
    parentPartId: nodes[b.parentPartIndex]!.id,
    title: b.title,
    createdAt: now
  }));
  return {
    id: ids.storyId ?? randomUUID(),
    title: imported.title,
    createdAt: now,
    updatedAt: now,
    facts: [],
    nodes,
    activeRootId: nodes[0]?.id ?? null,
    tags: [],
    recentNodeIds: [],
    chapterBreaks
  };
}
