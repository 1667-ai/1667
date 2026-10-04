import type { AsideAnchorView } from "../../../shared/aside-hop-model.js";
import type { AsideAnchor } from "../../../shared/aside-anchor.js";
import type { PlacementPick } from "./placement.js";
import type { AsideSessionResponse } from "../../../shared/aside-transport.js";

/**
 * Aside (#409 step 10d): a non-canon chat anchored to one take of one part.
 * The open surface, the question drafts and the one running ask all live at
 * the top level of `AppState`, because a running ask outlives the panel being
 * closed. See `actions.ts` for the rules.
 */

/** How the surface names its anchor: "Part N · take k/m". Any field can be
 * missing when the anchor's take is no longer on the line. */
export interface AsideAnchorLabel {
  readonly partNumber?: number;
  readonly takeIndex?: number;
  readonly takeCount?: number;
}

export interface AsideSurface {
  readonly storyId: string;
  readonly storyTitle: string;
  /** `null` is the story-level bucket of questions that belong to no take. */
  readonly anchor: AsideAnchor | null;
  readonly label: AsideAnchorLabel;
  readonly load: "loading" | "ready" | "failed";
  /** The sessions of this anchor, oldest first. */
  readonly sessions: readonly AsideSessionResponse[];
  /** Every anchor that has sessions, for the "elsewhere" strip. */
  readonly anchors: readonly AsideAnchorView[];
  readonly sessionIndex: number;
  /** The selected turn of the current session. */
  readonly turnCursor: number;
}

/** The one ask, retake or session change that is running. */
export interface AsideRun {
  readonly storyId: string;
  readonly storyTitle: string;
  readonly kind: "ask" | "retake" | "change";
  /** The question being answered (empty for a change). */
  readonly question: string;
  /** The answer so far, presented once per animation frame. */
  readonly text: string;
  readonly phase: "waiting" | "thinking" | "writing";
  /** True after Stop, until the answer or the failure arrives. */
  readonly stopping: boolean;
}

/** A retake with an edited question: the turn it replaces and the text so far. */
export interface AsideRetakeDraft {
  readonly storyId: string;
  readonly sessionId: string;
  readonly turnIndex: number;
  readonly text: string;
}

/** A destructive change that waits for the writer's yes. */
export interface AsideConfirm {
  readonly kind: "delete" | "reset" | "clear";
  /** The selected turn when it was asked. */
  readonly turnIndex: number;
}

/** "Insert into story": the answer waits while the writer picks a place. */
export interface AsidePlacement {
  readonly storyId: string;
  readonly answer: string;
  readonly pick: PlacementPick;
  /** True while the create call runs. */
  readonly placing: boolean;
}

export interface AsideState {
  readonly surface: AsideSurface | null;
  /** The unsent question of each story. */
  readonly drafts: Readonly<Record<string, string>>;
  readonly retake: AsideRetakeDraft | null;
  readonly run: AsideRun | null;
  readonly confirm: AsideConfirm | null;
  readonly placement: AsidePlacement | null;
}

export function initialAsideState(): AsideState {
  return { surface: null, drafts: {}, retake: null, run: null, confirm: null, placement: null };
}

export function currentSession(surface: AsideSurface): AsideSessionResponse | null {
  return surface.sessions[surface.sessionIndex] ?? null;
}

export function sameAnchor(left: AsideAnchor | null, right: AsideAnchor | null): boolean {
  if (left === null || right === null) return left === right;
  return left.partId === right.partId && left.takeId === right.takeId;
}
