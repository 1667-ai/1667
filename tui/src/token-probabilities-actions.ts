import type { KeyEvent } from "@opentui/core";
import type { TokenProbabilityRecord } from "../../shared/token-probabilities.js";
import type { ActionContext } from "./action-context.js";
import type { AppSource } from "./app.js";
import type { ResolvedKey } from "./keys.js";
import { createStoryViewModel, rowPart } from "./model.js";
import type { RuntimeState, TokenProbabilitiesViewerState } from "./state.js";
import {
  resolveTokenProbabilityEmptyReason,
  tokenProbabilityAlternativeRows
} from "./token-probabilities-model.js";

/** Open the read-only token probability viewer on the focused story part
 *  (issue #291 phase 4). `l` for "logprobs" — the word the header shows. */
export async function openTokenProbabilities(
  state: RuntimeState,
  source: AppSource,
  context: ActionContext
): Promise<void> {
  const part = rowPart(createStoryViewModel(state.payload, state.stream), state.focusIndex);
  if (part === null) return;
  state.mode = "PROBS";
  state.probs = initialProbsState(part.id, part.stub.tokenProbabilities === true, source);
  context.repaint();
  if (part.stub.tokenProbabilities === true) {
    await loadTokenProbabilities(state, source, context, part.id);
  }
}

/** Local state only: unlike NAV's own focus, `nodeId` does not travel back
 *  onto `state.focusIndex` when the viewer closes — the same choice the
 *  request viewer's own `cursor` makes for the message it is looking at. */
export function closeTokenProbabilities(state: RuntimeState): void {
  const probs = state.probs;
  if (probs === null) return;
  state.mode = probs.returnMode;
  state.probs = null;
}

export function resolveTokenProbabilitiesKey(key: KeyEvent): ResolvedKey {
  if (key.name === "left") return { action: "take-previous" };
  if (key.name === "right") return { action: "take-next" };
  if (key.name === "up") return { action: "focus-previous" };
  if (key.name === "down") return { action: "focus-next" };
  if (key.name === "tab") return { action: "next-part" };
  return { action: "none" };
}

export async function tokenProbabilitiesAction(
  resolved: ResolvedKey,
  state: RuntimeState,
  source: AppSource,
  context: ActionContext
): Promise<void> {
  const probs = state.probs;
  if (probs === null) return;
  if (resolved.action === "cancel") { closeTokenProbabilities(state); return; }
  if (resolved.action === "take-previous") { moveToken(probs, -1); return; }
  if (resolved.action === "take-next") { moveToken(probs, 1); return; }
  if (resolved.action === "focus-previous") { moveAlternative(probs, -1); return; }
  if (resolved.action === "focus-next") { moveAlternative(probs, 1); return; }
  if (resolved.action === "next-part") await moveToNextPart(state, source, context);
}

function moveToken(probs: TokenProbabilitiesViewerState, delta: -1 | 1): void {
  const total = probs.record?.steps.length ?? 0;
  if (total === 0) return;
  const next = Math.max(0, Math.min(total - 1, probs.tokenIndex + delta));
  if (next === probs.tokenIndex) return;
  probs.tokenIndex = next;
  // Each token starts its own, freshly-collapsed alternatives list.
  probs.altIndex = 0;
  probs.expanded = false;
}

function moveAlternative(probs: TokenProbabilitiesViewerState, delta: -1 | 1): void {
  const step = probs.record?.steps[probs.tokenIndex];
  if (step === undefined) return;
  const rows = tokenProbabilityAlternativeRows(step, probs.expanded);
  if (rows.length === 0) return;
  const current = rows[probs.altIndex];
  if (delta > 0 && !probs.expanded && current?.kind === "collapsed") {
    // The synthetic row is replaced in place by the alternatives it stood
    // for, so the cursor already sits on the first of them — no extra move.
    probs.expanded = true;
    return;
  }
  probs.altIndex = Math.max(0, Math.min(rows.length - 1, probs.altIndex + delta));
}

async function moveToNextPart(
  state: RuntimeState,
  source: AppSource,
  context: ActionContext
): Promise<void> {
  const probs = state.probs;
  if (probs === null) return;
  const view = createStoryViewModel(state.payload, state.stream);
  const index = view.parts.findIndex((part) => part.id === probs.nodeId);
  const next = index === -1 ? undefined : view.parts[index + 1];
  if (next === undefined) return;
  state.probs = initialProbsState(next.id, next.stub.tokenProbabilities === true, source);
  context.repaint();
  if (next.stub.tokenProbabilities === true) {
    await loadTokenProbabilities(state, source, context, next.id);
  }
}

function initialProbsState(
  nodeId: string,
  hasRecord: boolean,
  source: AppSource
): TokenProbabilitiesViewerState {
  return {
    nodeId,
    tokenIndex: 0,
    altIndex: 0,
    expanded: false,
    record: null,
    loading: hasRecord,
    empty: hasRecord ? null : resolveTokenProbabilityEmptyReason(source.settingsView),
    returnMode: "NAV"
  };
}

async function loadTokenProbabilities(
  state: RuntimeState,
  source: AppSource,
  context: ActionContext,
  nodeId: string
): Promise<void> {
  const ran = await context.backend.run("loading token probabilities", async (task) => {
    let record: TokenProbabilityRecord | null = null;
    try {
      record = await source.api.getTokenProbabilities(task.storyId, nodeId);
    } catch {
      // The stub said the take had one; a 404 here is a race (pruned, or the
      // object failed to write) rather than a capability question. Either
      // way a broken diagnostic must never block the writer, so this falls
      // back to the same honest empty state a take that never asked would
      // show, instead of failing the whole viewer.
      record = null;
    }
    if (state.probs === null || state.probs.nodeId !== nodeId) return;
    state.probs.record = record;
    state.probs.empty = record === null ? resolveTokenProbabilityEmptyReason(source.settingsView) : null;
    state.probs.loading = false;
  });
  if (!ran && state.probs !== null && state.probs.nodeId === nodeId) {
    // Another backend task already owns the runtime — its own busy toast
    // already says why, so this just stops the viewer from spinning forever.
    state.probs.loading = false;
    state.probs.empty = { text: "Busy. Try again once the current task finishes." };
  }
}
