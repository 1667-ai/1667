import { createStoryIndex } from "../../shared/story-model.js";
import { childrenOf, takeIndex } from "../../shared/story-tree.js";
import type { StoryPayload } from "../../shared/types.js";
import type { StoryPart } from "./model.js";

/** Labels that a later key promotion can use inside one apparatus seam. */
export const APPARATUS_LABELS = [
  "b", "d", "e", "f", "h", "j", "k", "m", "n", "o",
  "p", "q", "s", "t", "u", "w", "x", "y", "z"
] as const;

export type ApparatusLabel = (typeof APPARATUS_LABELS)[number];

/** One inactive take doorway. `preview` is only a server-supplied preview;
 * it is not the take's full reading and never makes this row an equivalence
 * claim about the inactive take. */
export interface ApparatusDoorway {
  readonly label: ApparatusLabel | null;
  readonly preview: string;
  /** One-based position among all sibling takes, including the active take. */
  readonly takeIndex: number;
  readonly childCount: number;
}

export interface EmptyApparatusSeam {
  readonly kind: "empty";
  readonly doorways: readonly [];
}

/** Beta intentionally stops at doorways. Inactive take text is not in the
 * payload, so this state must not be read as an exact textual apparatus. */
export interface NotYetApparatusSeam {
  readonly kind: "not-yet";
  readonly takeCount: number;
  readonly doorways: readonly ApparatusDoorway[];
}

export type ApparatusSeam = EmptyApparatusSeam | NotYetApparatusSeam;

/** Keep key routing on the same visible doorway budget as the renderer. */
export function visibleApparatusDoorways(
  seam: ApparatusSeam,
  narrow: boolean
): readonly ApparatusDoorway[] {
  if (seam.kind !== "not-yet") return [];
  return seam.doorways.slice(0, narrow ? 2 : 4);
}

/** Derive one focused part's sibling seam without fetching or interpreting
 * inactive take text. The active take is the negative space of the result. */
export function deriveApparatusSeam(
  payload: StoryPayload,
  part: StoryPart
): ApparatusSeam {
  const index = createStoryIndex(payload);
  const siblings = childrenOf(index.tree, part.node.parentId);

  // `StoryPart.siblingCount` is the focused view's seam contract. The tree is
  // still checked so a stale part cannot turn a changed payload into rows.
  if (part.siblingCount <= 1
    || siblings.length <= 1
    || !siblings.some(({ id }) => id === part.id)) {
    return {
      kind: "empty",
      doorways: []
    };
  }

  let labelOffset = 0;
  const doorways = siblings.flatMap((node): ApparatusDoorway[] => {
    if (node.id === part.id) return [];
    const position = takeIndex(index.tree, node.id);
    const label = APPARATUS_LABELS[labelOffset++] ?? null;
    return [{
      label,
      preview: node.preview,
      takeIndex: position.index,
      childCount: node.childCount
    }];
  });

  return {
    kind: "not-yet",
    takeCount: siblings.length,
    doorways
  };
}

/** Resolve a currently assigned seam label. An exhausted label has no target
 * yet, so callers cannot accidentally promote it to a guessed take. */
export function resolveApparatusLabel(
  doorways: readonly ApparatusDoorway[],
  label: string
): ApparatusDoorway | null {
  return doorways.find((doorway) => doorway.label === label) ?? null;
}
