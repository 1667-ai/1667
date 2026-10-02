import { createStoryIndex, type StoryIndex } from "../../../shared/story-model.js";
import { isChapterSummary, pathTo } from "../../../shared/story-tree.js";
import type { StoryPayload } from "../../../shared/types.js";

/**
 * Where a switch to any node of the story goes, worked out from the open
 * payload alone. `focus`: the node is already on the line, so nothing is sent.
 * `switch`: the line has to change. `anchorId` is the part on the current line
 * that the switch replaces: the first part where the two lines part ways, or
 * the leaf when the target hangs below it (`extendsLeaf`: nothing on the line
 * is replaced, the line only grows).
 */
export type LineSwitchPlan =
  | { readonly kind: "focus"; readonly partId: string }
  | { readonly kind: "switch"; readonly anchorId: string; readonly extendsLeaf: boolean };

export type LineSwitch = Extract<LineSwitchPlan, { kind: "switch" }>;

/** `null` when the node is not on the story's tree any more, or is a chapter
 * summary (a line never runs through one). */
export function planLineSwitch(payload: StoryPayload, targetId: string): LineSwitchPlan | null {
  const index = createStoryIndex(payload);
  const target = index.tree.nodesById.get(targetId);
  if (target === undefined || isChapterSummary(target)) return null;
  const chain = pathTo(index.tree, targetId);
  const path = payload.path;
  if (path.length === 0) return null;
  let shared = 0;
  while (shared < chain.length && shared < path.length && chain[shared]!.id === path[shared]!.id) shared += 1;
  if (shared === chain.length) return { kind: "focus", partId: targetId };
  if (shared === path.length) return { kind: "switch", anchorId: path[shared - 1]!.id, extendsLeaf: true };
  return { kind: "switch", anchorId: path[shared]!.id, extendsLeaf: false };
}

/** The take of the anchor's part that the target's line runs through: the
 * sibling the manuscript shows as "take i of n" while the switch is pending. */
export function forkTakeOf(index: StoryIndex, targetId: string, anchorDepth: number): string {
  return pathTo(index.tree, targetId)[anchorDepth - 1]?.id ?? targetId;
}
