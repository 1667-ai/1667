import { randomUUID } from "node:crypto";
import type { ChapterBreak, Story, StoryNode } from "../shared/types.js";

export { MAX_IMPORT_BYTES } from "../shared/types.js";

export interface ImportedPart {
  instruction: string;
  text: string;
  createdAt: string;
  /** Index into the same `parts` array of this take's parent. Absent means
   *  "the previous array element" (or a root, at index 0) — the straight
   *  chain every non-branching importer produces without stating it. Set
   *  this to express a retry or a swipe: more than one part can name the
   *  same parentIndex, which makes them siblings — alternate takes at one
   *  point in the story. */
  parentIndex?: number | null;
  /** Whether this take continues the active storyline from its parent.
   *  Absent means active. At most one sibling under one parentIndex should
   *  be active; `storyFromImport` takes the first by array order and treats
   *  the rest as alternates regardless of this flag. */
  active?: boolean;
}

export interface GenericImport {
  title: string;
  parts: ImportedPart[];
  chapterBreaks?: readonly { parentPartIndex: number; title: string }[];
}

export const MAX_PARTS = 5_000;
/** Cumulative characters in the story written to disk. */
export const MAX_TOTAL_CHARS = 4_000_000;

export function totalImportedPartChars(parts: readonly ImportedPart[]): number {
  let total = 0;
  for (const part of parts) total += part.text.length;
  return total;
}

export function storyFromImport(
  imported: GenericImport,
  ids: {
    storyId?: string;
    nodeId?: (index: number) => string;
    chapterBreakId?: (index: number) => string;
  } = {}
): Story {
  const now = new Date().toISOString();
  const nodeIds = imported.parts.map((_part, index) => ids.nodeId?.(index) ?? randomUUID());
  const parentIndices = imported.parts.map((part, index) => {
    const parentIndex = part.parentIndex !== undefined ? part.parentIndex : (index === 0 ? null : index - 1);
    if (parentIndex !== null && (parentIndex < 0 || parentIndex >= index)) {
      throw new Error(`Import part ${index} names a parentIndex that is not an earlier part`);
    }
    return parentIndex;
  });
  const nodes: StoryNode[] = imported.parts.map((part, index) => ({
    id: nodeIds[index]!,
    parentId: parentIndices[index] === null ? null : nodeIds[parentIndices[index]!]!,
    model: "imported",
    instruction: part.instruction,
    text: part.text,
    createdAt: part.createdAt,
    activeChildId: null
  }));

  // The first child (by array order) whose `active` flag is not false wins its
  // parent's `activeChildId`; every other sibling stays in the tree as an
  // alternate take a human can switch to later.
  const activeChildByParent = new Map<number | null, number>();
  imported.parts.forEach((part, index) => {
    if (part.active === false) return;
    const parentIndex = parentIndices[index]!;
    if (!activeChildByParent.has(parentIndex)) activeChildByParent.set(parentIndex, index);
  });
  imported.parts.forEach((_part, index) => {
    const activeChild = activeChildByParent.get(index);
    if (activeChild !== undefined) nodes[index]!.activeChildId = nodeIds[activeChild]!;
  });

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
    activeRootId: nodeIds[activeChildByParent.get(null) ?? -1] ?? null,
    tags: [],
    recentNodeIds: [],
    chapterBreaks
  };
}
