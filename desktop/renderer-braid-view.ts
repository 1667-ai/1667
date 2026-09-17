/** Braid strip D-36: above the composer, one ribbon per story line that
 * passes through the focused part — your line straight and `--amber`, every
 * tagged line that shares that part `--amber-soft`. Hidden when the story has
 * no tagged line besides the current one. */
import type { StoryPayload } from "../shared/types.js";
import { pathTo } from "../shared/story-tree.js";
import { actionButton, el } from "./renderer-dom.js";
import { effectiveFocusedPartId, type RendererActions, type RendererState } from "./renderer-model.js";

const NEAREST_SHOWN = 3;

export interface BraidLine {
  readonly kind: "current" | "tag";
  readonly label: string;
  readonly nodeId: string;
  readonly words: number;
  /** 0 when the tagged line still agrees with the current line up to and
   * including the focused part (it only forks after); larger values are
   * farther back. `-1` for the current line, which never forks from itself. */
  readonly forkDistance: number;
}

/** Pure: every line through `story.path[focusedIndex]`, current line first.
 * "Through" means the tagged line's ancestry agrees with the current line
 * for every part *before* the focused one (so they share the same chain
 * leading into this fork) and the tagged line actually reaches this
 * position — whether it then takes the same take as the current line
 * (forking later) or a sibling take right here. Two sibling takes at the
 * same position never share a node id, so this cannot be checked by looking
 * for the focused part's own id in the tagged path. Exported for the layout
 * to be checked without Electron. */
export function linesThroughFocusedPart(story: StoryPayload, focusedIndex: number): BraidLine[] {
  if (focusedIndex < 0 || focusedIndex >= story.path.length) return [];
  const focusedNodeId = story.path[focusedIndex]!.id;
  const activeLeafId = story.path.at(-1)?.id;
  const currentWords = story.path.reduce((sum, node) => sum + (story.nodes.find((stub) => stub.id === node.id)?.words ?? 0), 0);
  const lines: BraidLine[] = [{ kind: "current", label: "you", nodeId: activeLeafId ?? focusedNodeId, words: currentWords, forkDistance: -1 }];
  for (const tag of story.tags) {
    if (tag.nodeId === activeLeafId) continue;
    let taggedPath;
    try {
      taggedPath = pathTo({ nodes: story.nodes, activeRootId: story.activeRootId }, tag.nodeId);
    } catch {
      continue;
    }
    if (taggedPath.length <= focusedIndex) continue;
    let sharesAncestry = true;
    for (let index = 0; index < focusedIndex; index += 1) {
      if (taggedPath[index]!.id !== story.path[index]!.id) { sharesAncestry = false; break; }
    }
    if (!sharesAncestry) continue;
    let branchIndex = focusedIndex - 1;
    while (branchIndex + 1 < taggedPath.length && branchIndex + 1 < story.path.length && taggedPath[branchIndex + 1]!.id === story.path[branchIndex + 1]!.id) {
      branchIndex += 1;
    }
    const words = taggedPath.reduce((sum, node) => sum + node.words, 0);
    lines.push({ kind: "tag", label: tag.name, nodeId: tag.nodeId, words, forkDistance: Math.max(0, focusedIndex - branchIndex) });
  }
  return lines;
}

/** Fold to "you" + the `NEAREST_SHOWN` nearest tagged lines once there are
 * more than `NEAREST_SHOWN + 1 + 1` (current, the shown ones, and one more
 * that would otherwise show alone) lines through the part. */
export function foldBraidLines(lines: readonly BraidLine[]): { readonly shown: readonly BraidLine[]; readonly hiddenCount: number } {
  const [current, ...tagged] = lines;
  if (current === undefined) return { shown: [], hiddenCount: 0 };
  if (tagged.length <= NEAREST_SHOWN + 1) return { shown: lines, hiddenCount: 0 };
  const nearest = [...tagged].sort((a, b) => a.forkDistance - b.forkDistance).slice(0, NEAREST_SHOWN);
  return { shown: [current, ...nearest], hiddenCount: tagged.length - nearest.length };
}

export function renderBraid(story: StoryPayload, state: RendererState, actions: RendererActions): HTMLElement | null {
  const focusedId = effectiveFocusedPartId(state, story);
  const focusedIndex = focusedId === null ? -1 : story.path.findIndex((node) => node.id === focusedId);
  if (focusedIndex === -1) return null;
  const lines = linesThroughFocusedPart(story, focusedIndex);
  if (lines.length <= 1) return null;
  const { shown, hiddenCount } = foldBraidLines(lines);
  const maxWords = Math.max(1, ...shown.map((line) => line.words));
  const strip = el("div", "braid-strip");
  for (const line of shown) {
    const width = Math.max(6, Math.round((line.words / maxWords) * 100));
    const ribbon = actionButton(`braid-ribbon braid-ribbon-${line.kind}`, "", () => {
      if (line.kind === "tag") actions.switchToTaggedLine(line.label, line.nodeId);
    });
    if (line.kind === "current") ribbon.disabled = true;
    ribbon.append(
      el("span", "braid-ribbon-bar", el("span", "braid-ribbon-fill")),
      el("span", "braid-ribbon-label", line.label)
    );
    ribbon.querySelector<HTMLElement>(".braid-ribbon-fill")!.style.width = `${width}%`;
    strip.append(ribbon);
  }
  if (hiddenCount > 0) {
    strip.append(actionButton("braid-ribbon braid-more", `${hiddenCount} others`, () => actions.setTab("map")));
  }
  return strip;
}
