/**
 * The one live generation the web UI can be running at a time (#409 step 5,
 * owner decision: one web generation at a time; it keeps writing in the
 * background when the reader leaves its story). Top level on `AppState`,
 * not inside `StoryState` — a generation outlives the reader navigating
 * away from the story it targets, so it cannot live inside state that only
 * exists while that story is the open route.
 *
 * Only the *presented* projection of a run lives here: the text and
 * reasoning the UI paints, throttled to one update per animation frame
 * (`stream-buffer.ts`). The authoritative buffers, the `AbortController`,
 * and the captured `StoryApi` live in `actions.ts`'s own closure — never in
 * this store-visible state — so a stale connection or a superseded run can
 * never be reconstructed from what a component reads here.
 */

export type GenerationMode = "append" | "take";

export interface GenerationReasoning {
  readonly text: string;
  readonly tokenCount: number;
}

interface GenerationRunFields {
  readonly genId: string;
  readonly storyId: string;
  readonly storyTitle: string;
  readonly mode: GenerationMode;
  /** The leaf being grown, for `mode: "append"`; `null` for `"take"`. */
  readonly appendTo: string | null;
  /** The new take's parent, for `mode: "take"`; `null` for `"append"` and
   *  for a brand new first part. */
  readonly parentId: string | null;
  /** `mode: "take"` only: the last existing part `Manuscript` still shows in
   *  full before the `StreamingPart` placeholder — the TUI's own "projected
   *  path" idea (`tui/src/request-projection.ts`). Every row whose
   *  `pathIndex` is at or before this one stays visible; every part after
   *  it (an old take's own continuation, about to be superseded) is
   *  hidden while this take streams. Unused for `mode: "append"` (nothing
   *  is hidden there — the leaf itself just grows). */
  readonly seamPathIndex: number;
  readonly instruction: string;
  /** The presented text — see the module doc for why this is a throttled
   *  projection, not the authoritative buffer. */
  readonly text: string;
  readonly reasoning: GenerationReasoning | null;
  /** `story/state.ts`'s `focusedPartId` at the moment this run started.
   *  Landing only moves focus onto the new leaf if the reader's focus still
   *  equals this — they never had it moved out from under them by a
   *  generation they were not even looking at. */
  readonly focusAtStart: string | null;
}

export interface GenerationRunningState extends GenerationRunFields {
  /** `"running"` while the model is still streaming; `"settling"` once Stop
   *  (or a timeout-class failure) has been requested and the stopped text is
   *  being committed. `stopRequested` distinguishes the two only for
   *  presentation (the bar's "Saving…" state) — `actions.ts`'s own closure
   *  is what actually gates whether a late delta is still accepted. */
  readonly kind: "running" | "settling";
  readonly stopRequested: boolean;
}

/** A generation whose commit failed (or whose connection dropped) with
 *  substantive text still uncommitted. Kept visible, with Copy and Discard,
 *  until the writer acts — decision 3: no auto-save after reconnect yet. */
export interface GenerationUnsavedState extends GenerationRunFields {
  readonly kind: "unsaved";
  readonly message: string;
}

export type GenerationState =
  | { readonly kind: "idle" }
  | GenerationRunningState
  | GenerationUnsavedState;

export function initialGenerationState(): GenerationState {
  return { kind: "idle" };
}

/** True while `storyId` may not accept a take switch: a generation is
 *  either writing into it, or trying to save into it, right now. Only the
 *  one story a generation targets is ever locked — every other story
 *  (including the library) stays fully interactive, which is what lets that
 *  generation keep writing in the background while the reader works
 *  elsewhere. `"unsaved"` does not lock: nothing is running or being saved
 *  any more, so switching a take in that story is safe again — the leftover
 *  prose sits beside the path, not under it. */
export function generationLocks(state: GenerationState, storyId: string): boolean {
  return (state.kind === "running" || state.kind === "settling") && state.storyId === storyId;
}

/** The story id a running/settling/unsaved generation targets, or `null`
 *  while idle — the one field every route needs to decide whether "a
 *  generation is happening, and where" without switching on `kind` itself. */
export function generationStoryId(state: GenerationState): string | null {
  return state.kind === "idle" ? null : state.storyId;
}

/** The read-only projection of a running/settling/unsaved generation that
 * `Manuscript`/`PartCard`/`StreamingPart` need to render it in place —
 * derived fresh from `GenerationState` by whichever caller has the matching
 * story open (`StoryView.tsx`), never stored on its own. `null` whenever
 * there is nothing to show for `storyId` (idle, or a background generation
 * targeting a different story — that story's own `StoryView`, once opened,
 * derives its own view the same way). */
export interface ManuscriptGeneration {
  readonly mode: GenerationMode;
  readonly appendTo: string | null;
  readonly seamPathIndex: number;
  readonly instruction: string;
  readonly text: string;
  readonly thinking: boolean;
  /** False only for `"unsaved"`: the text is frozen (no caret) — nothing is
   * still being written, and nothing will change until the writer discards
   * it or a retry lands. */
  readonly live: boolean;
}

export function manuscriptGenerationView(
  state: GenerationState,
  storyId: string
): ManuscriptGeneration | null {
  if (state.kind === "idle" || state.storyId !== storyId) return null;
  return {
    mode: state.mode,
    appendTo: state.appendTo,
    seamPathIndex: state.seamPathIndex,
    instruction: state.instruction,
    text: state.text,
    thinking: state.reasoning !== null && state.text.length === 0,
    live: state.kind !== "unsaved"
  };
}
