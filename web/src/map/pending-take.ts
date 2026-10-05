import { projectPendingTake } from "../../../shared/pending-take.js";
import type { StoryPayload } from "../../../shared/types.js";

/**
 * The take the map shows while a generation writes it. The web's generation
 * state has no node id for a take that does not exist yet, so the map gives
 * it one of its own; nothing sends it anywhere. The projected node holds no
 * text: the layouts depend on the shape of the story, and the text changes
 * every frame, so a text-free node keeps one projection for the whole run.
 */
export const PENDING_TAKE_PREFIX = "pending-take:";

export function isPendingTake(nodeId: string | null): boolean {
  return nodeId !== null && nodeId.startsWith(PENDING_TAKE_PREFIX);
}

export interface MapRun {
  readonly genId: string;
  readonly mode: "append" | "take";
  readonly appendTo: string | null;
  readonly parentId: string | null;
  readonly instruction: string;
}

/** The id the map marks as being written: the pending take, or the leaf an
 * append grows. */
export function streamTargetOf(run: MapRun | null): string | null {
  if (run === null) return null;
  return run.mode === "take" ? `${PENDING_TAKE_PREFIX}${run.genId}` : run.appendTo;
}

/** The payload the map draws: the story, plus the pending take of a run that
 * writes a new one. An append needs no projection (its leaf is on the story
 * already), and a run whose parent left the reading line shows nothing new. */
export function withPendingTake(payload: StoryPayload, run: MapRun | null, startedAt: string): StoryPayload {
  if (run === null || run.mode !== "take") return payload;
  const projection = projectPendingTake(payload, {
    targetId: `${PENDING_TAKE_PREFIX}${run.genId}`,
    parentId: run.parentId,
    instruction: run.instruction,
    startedAt,
    genId: run.genId,
    text: "",
    words: 0
  });
  return projection?.projected ?? payload;
}
