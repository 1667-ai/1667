import type { FactConsistencyOverlayState, RuntimeState } from "./state.js";

export const FACT_CONSISTENCY_RUNNING_TOAST =
  "Fact consistency check running · wait for it to finish";

/** A provider run can outlive its visible overlay and its original story. */
export function factConsistencyRunInFlight(
  state: Pick<RuntimeState, "factConsistencyRunsInFlight" | "factConsistency">
): boolean {
  return (state.factConsistencyRunsInFlight?.size ?? 0) > 0
    || state.factConsistency?.surface.phase === "running";
}

/** Apply the process quit policy to one Ctrl+C request. Provider work that is
 * not represented by `stream` or `abort` still needs the same confirmation
 * fence, so a hidden Fact consistency run cannot be lost on the first chord. */
export function requestQuitForState(
  state: Pick<RuntimeState,
    "stream" | "abort" | "quitArmed" | "toast" | "chapterSummary"
      | "payload" | "factConsistency" | "factConsistencyRunsInFlight">,
  repaint: () => void,
  quit: () => void
): void {
  const factCheckRunning = factConsistencyRunInFlight(state);
  if (state.stream === null && state.abort === null && !factCheckRunning) return quit();
  if (!state.quitArmed) {
    state.quitArmed = true;
    state.toast = factCheckRunning
      ? "Fact consistency check running · press Ctrl+C again to abandon check and quit"
      : state.chapterSummary !== null
      ? "chapter summary running · press Ctrl+C again to stop and quit"
      : "streaming · press Ctrl+C again to discard and quit";
    repaint();
    return;
  }
  state.abort?.controller.abort();
  quit();
}

/** Find a provider run that is hidden because the reader changed stories. */
export function factConsistencyRunForStory(
  state: Pick<RuntimeState, "factConsistencyRunsInFlight">,
  storyId: string
): FactConsistencyOverlayState | null {
  for (const run of state.factConsistencyRunsInFlight ?? []) {
    if (run.input.storyId === storyId) return run;
  }
  return null;
}

/** Retire active work after a story delete without dropping the quit fence.
 * The overlay stays in the in-flight set until its provider settles, but a
 * late failure must not be parked for a story that no longer exists. */
export function retireFactConsistencyRunsForDeletedStory(
  state: Pick<RuntimeState, "factConsistencyRunsInFlight" | "factConsistency">,
  storyId: string
): void {
  const current = state.factConsistency;
  if (current?.input.storyId === storyId) current.storyDeleted = true;
  for (const run of state.factConsistencyRunsInFlight ?? []) {
    if (run.input.storyId === storyId) run.storyDeleted = true;
  }
}

/** Take a retryable failure retained while another story was open. */
export function takeFactConsistencyFailureForStory(
  state: Pick<RuntimeState, "factConsistencyFailuresByStory">,
  storyId: string
): FactConsistencyOverlayState | null {
  const failures = state.factConsistencyFailuresByStory;
  const failure = failures?.get(storyId) ?? null;
  if (failure !== null) failures?.delete(storyId);
  return failure;
}

/** Keep one retryable failure per story; completed runs remain backend-owned. */
export function retainFactConsistencyFailure(
  state: Pick<RuntimeState, "factConsistencyFailuresByStory">,
  overlay: FactConsistencyOverlayState
): void {
  if (overlay.surface.phase !== "confirm" || overlay.surface.failure === undefined) return;
  const failures = state.factConsistencyFailuresByStory ??= new Map();
  failures.set(overlay.input.storyId, overlay);
}

/** Drop a superseded failure after a newer run or persisted result wins. */
export function forgetFactConsistencyFailure(
  state: Pick<RuntimeState, "factConsistencyFailuresByStory">,
  storyId: string,
  overlay?: FactConsistencyOverlayState
): void {
  const failures = state.factConsistencyFailuresByStory;
  if (failures === undefined) return;
  if (overlay === undefined || failures.get(storyId) === overlay) failures.delete(storyId);
}

/** A run belongs to the story that started it, even when its panel is hidden. */
export function factConsistencyCheckRunning(
  state: Pick<RuntimeState, "payload" | "factConsistency" | "factConsistencyRunsInFlight">
): boolean {
  if (state.factConsistency?.surface.phase === "running"
    && state.factConsistency.input.storyId === state.payload.id) return true;
  for (const run of state.factConsistencyRunsInFlight ?? []) {
    if (run.input.storyId === state.payload.id) return true;
  }
  return false;
}

/** A retained run or failure can be reopened from the palette. */
export function factConsistencyRunAvailable(
  state: Pick<RuntimeState, "payload" | "factConsistency" | "factConsistencyFailuresByStory">
): boolean {
  if (state.payload.hasFactConsistencyRun === true) return true;
  if (state.factConsistencyFailuresByStory?.has(state.payload.id) === true) return true;
  const retained = state.factConsistency;
  if (retained?.input.storyId !== state.payload.id) return false;
  const surface = retained.surface;
  return surface?.phase === "running"
    || surface?.phase === "results"
    || surface?.phase === "confirm" && surface.failure !== undefined;
}

/** Block provider entry points while the story-bound check owns the backend. */
export function blockFactConsistencyCheck(
  state: Pick<RuntimeState, "payload" | "factConsistency" | "toast">
): boolean {
  if (!factConsistencyCheckRunning(state)) return false;
  state.toast = FACT_CONSISTENCY_RUNNING_TOAST;
  return true;
}

/** Palette commands that start provider work covered by the same guard. */
export function factConsistencyBlocksPaletteCommand(commandId: string): boolean {
  return commandId === "summary"
    || commandId === "autoname"
    || commandId === "direct-take"
    || commandId === "retake";
}
