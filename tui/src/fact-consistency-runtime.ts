import type { AppSource } from "./app.js";
import type { ActionContext } from "./action-context.js";
import { storyAggregateVersionIsAtLeast } from "../../shared/story-aggregate-version.js";
import {
  completedFactConsistency,
  confirmingFactConsistency,
  factConsistencyKeyAction,
  runningFactConsistency,
  type FactConsistencyKey
} from "./fact-consistency-actions.js";
import {
  factConsistencyFindingStatus,
  factConsistencyPreflightFromRun,
  factConsistencyPreflightForPart,
  factConsistencyRunView,
  type FactConsistencyFinding
} from "./fact-consistency-check.js";
import {
  forgetFactConsistencyFailure,
  retainFactConsistencyFailure,
  takeFactConsistencyFailureForStory
} from "./fact-consistency-guard.js";
import type { FactConsistencyApi, FactConsistencyInput } from "./fact-consistency-api.js";
import { factsOpeningPartId } from "./facts-command-context.js";
import { openMap } from "./map-actions.js";
import { createStoryViewModel, rowIndexForNode } from "./model.js";
import { adoptSameStoryPayload } from "./story-adoption.js";
import { landOnNode } from "./story-actions.js";
import type { AppMode, ResolvedKey } from "./keys.js";
import type { FactConsistencyOverlayState, RuntimeState } from "./state.js";

export type FactConsistencyCommandScope = "chapter" | "story-line";

/** Open the confirmation after the backend has counted eligible parts. */
export async function openFactConsistencyCheck(
  state: RuntimeState,
  source: AppSource,
  context: ActionContext,
  scope: FactConsistencyCommandScope,
  returnMode: AppMode = state.mode
): Promise<void> {
  const current = state.factConsistency;
  if (current?.input.storyId === state.payload.id
    && current.surface.phase === "running") {
    current.returnMode = normalizedReturnMode(returnMode);
    state.mode = "FACT-CONSISTENCY";
    state.toast = "Fact consistency check already running";
    return;
  }
  const focusedPartId = factsOpeningPartId(state);
  if (focusedPartId === null) {
    state.toast = "select a story part before checking Facts";
    return;
  }
  const localScope = scope === "story-line" ? "line" : "chapter";
  const localPreflight = factConsistencyPreflightForPart(state.payload, focusedPartId, localScope);
  const input: FactConsistencyInput = {
    storyId: state.payload.id,
    focusedPartId,
    scope
  };
  const overlay: FactConsistencyOverlayState = {
    surface: confirmingFactConsistency(localPreflight),
    input,
    returnMode: normalizedReturnMode(returnMode),
    planPending: true
  };
  forgetFactConsistencyFailure(state, state.payload.id);
  state.factConsistency = overlay;
  state.mode = "FACT-CONSISTENCY";

  await planFactConsistencyCheck(state, source, context, overlay);
}

/** Resolve the exact backend workload before any provider check can start.
 * A refused or failed attempt stays retryable in the confirmation surface. */
async function planFactConsistencyCheck(
  state: RuntimeState,
  source: AppSource,
  context: ActionContext,
  overlay: FactConsistencyOverlayState
): Promise<void> {
  if (state.factConsistency !== overlay || overlay.surface.phase !== "confirm") return;
  const retryingAfterFailure = overlay.planFailure !== undefined;
  overlay.planPending = true;
  overlay.planFailure = undefined;
  const localPreflight = overlay.surface.preflight;
  try {
    const admitted = await context.backend.run("planning Fact consistency check", async (task) => {
      const plan = await factConsistencyApi(source).planFactConsistency(overlay.input);
      // The plan can settle after the writer has confirmed the check. A late
      // count must never move a running or completed surface back to confirm.
      if (!task.storyCurrent()
        || state.factConsistency !== overlay
        || overlay.surface.phase !== "confirm") return;
      if (!Number.isSafeInteger(plan.requestCount) || plan.requestCount < 0) {
        throw new Error("The server returned an invalid Fact consistency request count.");
      }
      const partCount = Math.max(0, plan.partCount);
      overlay.surface = confirmingFactConsistency({
        ...localPreflight,
        eligiblePartCount: partCount,
        skippedPartCount: Math.max(0, localPreflight.totalPartCount - partCount),
        requestCount: plan.requestCount,
        requestCountExact: true
      });
      // Older/demo adapters can omit the new field. Keep their surface
      // usable; the live backend rejects the empty token before provider work.
      overlay.input = { ...overlay.input, planToken: plan.planToken ?? "" };
      forgetFactConsistencyFailure(state, overlay.input.storyId, overlay);
      if (retryingAfterFailure) state.toast = null;
    });
    // A busy/refused plan must leave the confirmation in place. Enter retries
    // once the current backend task settles.
    if (!admitted && state.factConsistency === overlay) {
      overlay.planFailure = "busy";
    }
  } catch (error) {
    const message = factConsistencyError(error);
    const { planToken: _planToken, ...inputWithoutPlan } = overlay.input;
    overlay.input = inputWithoutPlan;
    overlay.surface = confirmingFactConsistency({
      ...overlay.surface.preflight,
      requestCount: undefined,
      requestCountExact: false
    }, message);
    overlay.planFailure = message;
    if (state.payload.id === overlay.input.storyId && state.factConsistency === overlay) {
      state.toast = "Fact consistency plan failed · " + message;
    } else if (state.payload.id !== overlay.input.storyId) {
      retainFactConsistencyFailure(state, overlay);
    }
  } finally {
    overlay.planPending = false;
  }
}

/** Reopen the retained run, or hydrate it from the story API. */
export async function showFactConsistencyFindings(
  state: RuntimeState,
  source: AppSource,
  context: ActionContext,
  returnMode: AppMode = state.mode
): Promise<boolean> {
  const normalized = normalizedReturnMode(returnMode);
  const retained = state.factConsistency;
  const retainedFailure = retained !== null && retained !== undefined
    && retained.surface.phase === "confirm"
    && retained.surface.failure !== undefined
    && retained.input.storyId === state.payload.id;
  const parkedFailure = takeFactConsistencyFailureForStory(state, state.payload.id);
  if (retainedFailure || parkedFailure !== null) {
    const failure = retainedFailure ? retained! : parkedFailure!;
    failure.returnMode = normalized;
    state.factConsistency = failure;
    state.mode = "FACT-CONSISTENCY";
    return true;
  }
  if (retained !== null && retained !== undefined
    && retained.surface.phase !== "confirm"
    && retained.input.storyId === state.payload.id) {
    retained.returnMode = normalized;
    state.mode = "FACT-CONSISTENCY";
    return true;
  }
  if (retained !== null && retained !== undefined) state.factConsistency = null;
  try {
    const loaded = await loadLatestFactConsistencyRun(state, source, context);
    if (loaded && state.factConsistency !== null && state.factConsistency !== undefined) {
      state.factConsistency.returnMode = normalized;
      state.mode = "FACT-CONSISTENCY";
      return true;
    }
  } catch (error) {
    state.toast = factConsistencyError(error);
  }
  return false;
}

/** Route the existing list-key vocabulary to the Fact consistency surface. */
export async function factConsistencyOverlayAction(
  resolved: ResolvedKey,
  state: RuntimeState,
  source: AppSource,
  context: ActionContext
): Promise<boolean> {
  const overlay = state.factConsistency;
  if (state.mode !== "FACT-CONSISTENCY" || overlay === null || overlay === undefined) {
    return false;
  }
  // The canonical overlay dispatcher opens the selected Fact. Do not consume
  // this action as an unknown Fact-consistency key when callers route here
  // directly.
  if (resolved.action === "open-facts") return false;
  const key = factConsistencyKey(resolved);
  if (resolved.action === "open-selected"
    && overlay.surface.phase === "confirm"
    && overlay.surface.preflight.eligiblePartCount === 0) {
    state.toast = "nothing to check";
    return true;
  }
  if (key === null) return true;
  // Fact checks run in the background and do not claim the ActionRuntime
  // slot. Recheck every provider owner at the point of confirmation so a
  // summary or another request that started after planning cannot be
  // bypassed. Keep the confirmation intact for a retry.
  if (key === "enter" && overlay.surface.phase === "confirm") {
    const busy = factConsistencyBusyReason(state, overlay);
    if (busy !== null) {
      state.toast = busy;
      return true;
    }
    if (overlay.surface.preflight.requestCountExact !== true) {
      await planFactConsistencyCheck(state, source, context, overlay);
      return true;
    }
  }
  const transition = factConsistencyKeyAction(overlay.surface, key);
  overlay.surface = transition.surface;
  const action = transition.action;
  switch (action.kind) {
    case "close":
      // Confirmation is not an active provider run. Escape cancels both a
      // fresh confirmation and a retained failure; only a running surface is
      // hidden while its ownership stays live in the background.
      if (overlay.surface.phase === "confirm") {
        forgetFactConsistencyFailure(state, overlay.input.storyId, overlay);
        state.factConsistency = null;
      }
      state.mode = overlay.returnMode;
      return true;
    case "move":
    case "none":
      return true;
    case "confirm":
      // This repaint is the admission point for the presented-input queue.
      // The await below is intentional: direct callers still observe full
      // settlement, while the interactive queue is released by the repaint
      // before the provider request starts.
      context.repaint();
      await runFactConsistencyCheck(state, source, context, overlay);
      return true;
    case "open":
      const finding = overlay.surface.phase === "results"
        ? overlay.surface.run.findings[overlay.surface.cursor]
        : undefined;
      await focusFactConsistencyPart(state, source, context, overlay, action.partId, finding);
      return true;
  }
}

function factConsistencyBusyReason(
  state: RuntimeState,
  overlay: FactConsistencyOverlayState
): string | null {
  if (overlay.planPending === true) {
    return "Fact consistency plan is still running · wait for it to finish";
  }
  // Summary can be hidden under another surface while it still owns the
  // provider. Check its visible marker before the generic backend owner so the
  // writer gets the existing, actionable summary message.
  if (state.summary !== null || state.abort?.kind === "summary") {
    return "summary running · esc cancels";
  }
  if (state.chapterSummary !== null) {
    return "chapter summary running · esc cancels";
  }
  if (state.aside?.busy === true) {
    return "Aside is answering · esc stops it first";
  }
  if (state.stream !== null || state.abort !== null) {
    return "stream running · esc stops it first";
  }
  if (state.backendTask !== null) {
    return `busy · ${state.backendTask.label} still running`;
  }
  return null;
}

/** Land on a finding's owning take, rerouting first when the result came from
 * a branch that is not the currently selected story line. */
async function focusFactConsistencyPart(
  state: RuntimeState,
  source: AppSource,
  context: ActionContext,
  overlay: FactConsistencyOverlayState,
  partId: string,
  finding?: FactConsistencyFinding
): Promise<void> {
  const status = finding === undefined
    ? "current"
    : factConsistencyFindingStatus(state.payload, finding);
  if (status === "stale") {
    // A result may name a take that the writer has since replaced or moved
    // away from. Never switch the active story line back to that old take.
    if (overlay.returnMode === "MAP" && state.map !== null) {
      state.mode = "MAP";
      state.toast = "Fact consistency finding is stale · MAP cursor unchanged";
      return;
    }
    state.toast = "Fact consistency finding is stale · story line unchanged";
    return;
  }
  if (status === "off-line") {
    if (overlay.returnMode === "MAP" && state.map !== null) {
      restoreFactFindingMapCursor(state, overlay.returnMode, partId);
      state.mode = "MAP";
      state.toast = "Fact consistency finding is off the active story line · MAP cursor moved";
      return;
    }
    openMap(state);
    restoreFactFindingMapCursor(state, "MAP", partId);
    state.mode = "MAP";
    state.toast = "Fact consistency finding is off the active story line · opened in MAP";
    return;
  }
  const view = createStoryViewModel(state.payload, state.stream);
  if (rowIndexForNode(view, partId) >= 0) {
    landOnNode(state, source, partId);
    restoreFactFindingMapCursor(state, overlay.returnMode, partId);
    state.mode = overlay.returnMode;
    return;
  }
  if (!state.payload.nodes.some(({ id, role }) => id === partId && role !== "summary")) {
    state.toast = "the finding's story position is no longer available";
    return;
  }
  try {
    const admitted = await context.backend.run("focusing Fact finding", async (task) => {
      const payload = await source.api.switchLine(task.storyId, partId);
      if (!task.storyCurrent() || state.factConsistency !== overlay) return;
      adoptSameStoryPayload(state, payload, context.cache);
      if (state.factConsistency !== overlay) return;
      landOnNode(state, source, partId);
      restoreFactFindingMapCursor(state, overlay.returnMode, partId);
      state.mode = overlay.returnMode;
    });
    if (!admitted && state.factConsistency === overlay) {
      state.mode = "FACT-CONSISTENCY";
    }
  } catch (error) {
    if (state.factConsistency === overlay) state.toast = factConsistencyError(error);
  }
}

/** Rehydrate the one latest run advertised by a story payload. This is a
 * separate hook so app startup/load paths can opt in without adding history
 * controls to the surface. */
export async function loadLatestFactConsistencyRun(
  state: RuntimeState,
  source: AppSource,
  context: ActionContext
): Promise<boolean> {
  if (state.payload.hasFactConsistencyRun !== true) return false;
  const run = await factConsistencyApi(source).getFactConsistencyRun(state.payload.id);
  if (run === null) return false;
  forgetFactConsistencyFailure(state, state.payload.id);
  const localScope = run.scope === "story-line" ? "line" : "chapter";
  // Keep the original scope counts while the anchor exists. If the anchor was
  // deleted or pruned, the persisted run still has enough data for results.
  const anchorExists = state.payload.nodes.some(({ id, role }) =>
    id === run.anchor.partId && role !== "summary"
  );
  const preflight = anchorExists
    ? factConsistencyPreflightForPart(state.payload, run.anchor.partId, localScope)
    : factConsistencyPreflightFromRun(run);
  const input: FactConsistencyInput = {
    storyId: state.payload.id,
    focusedPartId: run.anchor.partId,
    scope: run.scope
  };
  state.factConsistency = {
    surface: completedFactConsistency(preflight, factConsistencyRunView(run, state.payload)),
    input,
    returnMode: "NAV"
  };
  void context;
  return true;
}

async function runFactConsistencyCheck(
  state: RuntimeState,
  source: AppSource,
  context: ActionContext,
  overlay: FactConsistencyOverlayState
): Promise<void> {
  const input = overlay.input;
  forgetFactConsistencyFailure(state, input.storyId, overlay);
  const runsInFlight = state.factConsistencyRunsInFlight ??= new Set();
  runsInFlight.add(overlay);
  try {
    const result = await factConsistencyApi(source).checkFactConsistency({
      ...input,
      planToken: input.planToken ?? ""
    });
    // A story switch retires this story-bound overlay. Keep the late result
    // persisted in the backend, but never adopt its payload into the new
    // story or leave a running marker that blocks a later reopen.
    if (overlay.storyDeleted === true
      || state.payload.id !== input.storyId
      || state.factConsistency !== overlay) {
      if (state.payload.id !== input.storyId && state.factConsistency === overlay) {
        state.factConsistency = null;
      }
      return;
    }
    const panelVisible = state.mode === "FACT-CONSISTENCY";
    const responseSelectedTakeIds = new Set(result.payload.path.map(({ id }) => id));
    if (factResponseIsCurrentOrNewer(state.payload, result.payload)) {
      adoptSameStoryPayload(state, result.payload, context.cache);
    }
    if (state.factConsistency !== overlay) return;
    forgetFactConsistencyFailure(state, input.storyId, overlay);
    const run = factConsistencyRunView(result.run, state.payload, {
      selectedTakeIds: responseSelectedTakeIds
    });
    overlay.surface = completedFactConsistency(overlay.surface.preflight, run);
    if (panelVisible) state.mode = "FACT-CONSISTENCY";
    else state.toast = factConsistencyCompletionToast(
      run.findings.length,
      run.rejectedCount,
      run.uncheckedParts.length
    );
  } catch (error) {
    if (overlay.storyDeleted === true) return;
    const message = factConsistencyError(error);
    const { planToken: _planToken, ...inputWithoutPlan } = overlay.input;
    overlay.input = inputWithoutPlan;
    overlay.surface = confirmingFactConsistency({
      ...overlay.surface.preflight,
      requestCount: undefined,
      requestCountExact: false
    }, message);
    overlay.planFailure = message;
    if (state.payload.id === input.storyId && state.factConsistency === overlay) {
      state.toast = "Fact consistency failed · " + message;
    } else if (state.payload.id !== input.storyId) {
      retainFactConsistencyFailure(state, overlay);
    }
  } finally {
    runsInFlight.delete(overlay);
  }
}

function restoreFactFindingMapCursor(
  state: RuntimeState,
  returnMode: FactConsistencyOverlayState["returnMode"],
  partId: string
): void {
  if (returnMode !== "MAP" || state.map === null) return;
  state.map.pathCursorId = partId;
  state.map.treeCursorId = partId;
}

function factConsistencyApi(source: AppSource): FactConsistencyApi {
  const api = source.api;
  if (api.planFactConsistency === undefined
    || api.checkFactConsistency === undefined
    || api.getFactConsistencyRun === undefined) {
    throw new Error("Fact consistency is not available in this backend");
  }
  return {
    planFactConsistency: api.planFactConsistency,
    checkFactConsistency: api.checkFactConsistency,
    getFactConsistencyRun: api.getFactConsistencyRun
  };
}

function factConsistencyKey(resolved: ResolvedKey): FactConsistencyKey | null {
  if (resolved.action === "cancel") return "escape";
  if (resolved.action === "focus-next") return "down";
  if (resolved.action === "focus-previous") return "up";
  if (resolved.action === "open-selected") return "enter";
  return null;
}

function normalizedReturnMode(mode: AppMode): "NAV" | "COMPOSE" | "MAP" {
  return mode === "COMPOSE" || mode === "MAP" ? mode : "NAV";
}

/** Delayed Fact responses cannot overwrite newer writer payloads. */
function factResponseIsCurrentOrNewer(
  current: RuntimeState["payload"],
  candidate: RuntimeState["payload"]
): boolean {
  const currentVersion = current.aggregateVersion;
  if (currentVersion === undefined) return true;
  const candidateVersion = candidate.aggregateVersion;
  return candidateVersion !== undefined
    && storyAggregateVersionIsAtLeast(candidateVersion, currentVersion);
}

function factConsistencyCompletionToast(
  findings: number,
  rejected: number,
  unchecked: number
): string {
  return "Fact consistency complete · "
    + findings + " findings · "
    + rejected + " rejected · "
    + unchecked + " unchecked";
}

function factConsistencyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
