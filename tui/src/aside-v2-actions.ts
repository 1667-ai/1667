/** Aside v2 session and turn actions. The v1 reducer remains in aside-actions. */
import type { ActionRunner, ActionTask } from "./action-runtime.js";
import type { StoryApi } from "./api.js";
import {
  asideBodyHeight,
  asideComposerRows,
  clearAsideStream,
  revealAsideFocusedNote
} from "./aside-actions.js";
import {
  currentAsideSession,
  currentAsideTurns,
  isAsideV2,
  setAsideSessionTurns,
  type AsideDeleteUndo,
  type AsideSessionSurfaceState,
  type AsideSessionView,
  type AsideSurfaceState,
  type AsideTurnView
} from "./aside-surface.js";
import type { ResolvedKey } from "./keys.js";
import type { RuntimeState } from "./state.js";
import { adoptSameStoryPayload } from "./story-adoption.js";
import { recordNotice } from "./notice-log.js";
import { saveConfig } from "./config.js";
import type { ReasoningDelta } from "./worker-pending.js";
import type { ProseStyle, WrapCache } from "./wrap.js";
import { createStoryViewModel, rowIndexForNode } from "./model.js";
import { followStoryViewport } from "./viewport-intent.js";
import type { AsideAnchor } from "../../shared/aside-session.js";
import { asideSessionsFromResponse } from "./aside-v2-layout.js";
import {
  applyAsideV2Settlement,
  reconcileAsidePresence
} from "./aside-v2-settlement.js";
import {
  asideHopAnchorIndex,
  asideHopTarget,
  orderAsideAnchors
} from "./aside-hop.js";

type AsideContext = {
  readonly source: { api: StoryApi; config: RuntimeState["config"] };
  readonly backend: ActionRunner;
  readonly cache?: WrapCache<ProseStyle>;
  readonly repaint?: () => void;
  readonly renderer?: { readonly width: number; readonly height: number } | null;
  readonly toast?: string | null;
};

function revealFocusedTurn(
  surface: AsideSessionSurfaceState,
  context: AsideContext
): void {
  const width = context.renderer?.width ?? 80;
  const height = context.renderer?.height ?? 24;
  const composerRows = asideComposerRows(height);
  revealAsideFocusedNote(
    surface,
    width,
    asideBodyHeight(surface, width, height, composerRows, context.toast)
  );
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

function turnWords(turn: AsideTurnView): number {
  return `${turn.q} ${turn.a}`.trim().split(/\s+/u).filter(Boolean).length;
}

function applySessionResponse(
  state: RuntimeState,
  surface: AsideSessionSurfaceState,
  value: unknown,
  cache?: WrapCache<ProseStyle>
): void {
  const result = record(value);
  let payload: RuntimeState["payload"] | undefined;
  if (result?.payload !== undefined && result.payload !== null
    && typeof result.payload === "object") {
    payload = result.payload as RuntimeState["payload"];
    if (cache === undefined) state.payload = payload;
    else adoptSameStoryPayload(state, payload, cache);
  }
  if (payload !== undefined) reconcileAsidePresence(surface, payload);
  applyAsideV2Settlement(surface, value);
  if (payload !== undefined) reconcileAsidePresence(surface, payload);
}

function currentAnchor(surface: AsideSessionSurfaceState): AsideAnchor | null {
  const anchor = surface.anchor;
  return anchor === null ? null : { partId: anchor.partId, takeId: anchor.takeId };
}

function taskCurrent(
  state: RuntimeState,
  surface: AsideSessionSurfaceState,
  task: ActionTask
): boolean {
  return state.aside === surface
    && state.payload.id === surface.storyId
    && task.owns()
    && task.storyCurrent();
}

function taskInteractionCurrent(
  state: RuntimeState,
  surface: AsideSessionSurfaceState,
  task: ActionTask
): boolean {
  return taskCurrent(state, surface, task) && task.interactionCurrent();
}

function restoreDelete(
  surface: AsideSessionSurfaceState,
  undo: AsideDeleteUndo
): boolean {
  const sessionIndex = surface.sessions.findIndex((session) => session.id === undo.sessionId);
  if (sessionIndex < 0) return false;
  const owningSessionSelected = surface.sessions[surface.sessionIndex]?.id === undo.sessionId;
  const session = surface.sessions[sessionIndex]!;
  const turns = session.turns.slice();
  turns.splice(Math.min(undo.turnIndex, turns.length), 0, undo.turn);
  setAsideSessionTurns(surface, sessionIndex, turns);
  if (owningSessionSelected) {
    surface.sessionIndex = sessionIndex;
    surface.turnCursor = undo.turnIndex;
    surface.scrollTop = null;
  }
  surface.deleteUndo = null;
  return true;
}

function restorePendingDelete(surface: AsideSessionSurfaceState): boolean {
  const undo = surface.deleteUndo;
  return undo === null ? false : restoreDelete(surface, undo);
}

export function cycleAsideSession(surface: AsideSessionSurfaceState, delta: number): boolean {
  if (surface.busy || surface.sessions.length === 0) return false;
  const count = surface.sessions.length;
  surface.sessionIndex = (surface.sessionIndex + delta + count) % count;
  const session = currentAsideSession(surface);
  if (session !== null) surface.anchor = session.anchor;
  surface.anchorIndex = asideHopAnchorIndex(
    surface.anchors,
    surface.anchor
  );
  surface.turnCursor = Math.max(0, (session?.turns.length ?? 1) - 1);
  surface.focus = session?.turns.length === 0 ? "composer" : "turns";
  surface.useMenu = null;
  surface.confirmReset = null;
  surface.scrollTop = null;
  return true;
}

export function newAsideSession(surface: AsideSessionSurfaceState): boolean {
  if (surface.busy) return false;
  const id = `session-${crypto.randomUUID()}`;
  const session: AsideSessionView = {
    id,
    title: "new session",
    anchor: surface.anchor,
    turns: []
  };
  surface.sessions.push(session);
  surface.sessionIndex = surface.sessions.length - 1;
  surface.turnCursor = 0;
  surface.focus = "composer";
  surface.useMenu = null;
  surface.confirmReset = null;
  surface.scrollTop = null;
  return true;
}

export function toggleAsideThoughts(surface: AsideSessionSurfaceState): boolean {
  surface.thoughtsVisible = !surface.thoughtsVisible;
  surface.confirmReset = null;
  return true;
}

function removeTurn(surface: AsideSessionSurfaceState): boolean {
  const session = currentAsideSession(surface);
  if (session === null || session.turns[surface.turnCursor] === undefined) return false;
  const turn = session.turns[surface.turnCursor]!;
  const undo: AsideDeleteUndo = {
    sessionId: session.id,
    turnIndex: surface.turnCursor,
    turn
  };
  surface.deleteUndo = undo;
  setAsideSessionTurns(
    surface,
    surface.sessionIndex,
    session.turns.filter((_, index) => index !== surface.turnCursor)
  );
  surface.turnCursor = Math.max(0, Math.min(
    Math.max(0, currentAsideTurns(surface).length - 1), surface.turnCursor
  ));
  surface.confirmReset = null;
  return true;
}

export function undoAsideDelete(surface: AsideSurfaceState): boolean {
  return isAsideV2(surface) && restorePendingDelete(surface);
}

async function commitAsideDelete(
  state: RuntimeState,
  surface: AsideSessionSurfaceState,
  api: StoryApi,
  cache: WrapCache<ProseStyle> | undefined,
  task: ActionTask,
  undo: AsideDeleteUndo
): Promise<void> {
  const method = api.deleteAsideTurn;
  if (method === undefined) {
    if (taskInteractionCurrent(state, surface, task)) restoreDelete(surface, undo);
    throw new Error("This transport cannot delete Aside turns.");
  }
  try {
    const result = await method({
      storyId: surface.storyId,
      sessionId: undo.sessionId,
      turnIndex: undo.turnIndex,
      anchor: currentAnchor(surface)
    });
    if (!taskInteractionCurrent(state, surface, task) || surface.deleteUndo !== null) return;
    applySessionResponse(state, surface, result, cache);
  } catch (error) {
    if (taskCurrent(state, surface, task) && surface.deleteUndo === null) {
      restoreDelete(surface, undo);
    }
    throw error;
  }
}

export function resetAsideStatus(surface: AsideSessionSurfaceState): string {
  const turns = currentAsideTurns(surface);
  const after = turns.slice(surface.turnCursor + 1);
  const words = after.reduce((sum, turn) => sum + turnWords(turn), 0);
  return ` RESET  everything after this answer dies · ${after.length} turns · ${words} words`;
}

async function resetAside(
  state: RuntimeState,
  surface: AsideSessionSurfaceState,
  context: AsideContext,
  task: ActionTask
): Promise<void> {
  const session = currentAsideSession(surface);
  if (session === null || surface.turnCursor >= session.turns.length - 1) return;
  const sessionId = session.id;
  const method = context.source.api.resetAside;
  if (method === undefined) {
    throw new Error("This transport cannot reset an Aside session.");
  }
  const turnIndex = surface.turnCursor;
  const kept = session.turns.slice(0, surface.turnCursor + 1);
  const result = await method({
    storyId: surface.storyId,
    sessionId: session.id,
    turnIndex,
    anchor: currentAnchor(surface)
  });
  if (!taskCurrent(state, surface, task)) return;
  const sessionIndex = surface.sessions.findIndex((entry) => entry.id === sessionId);
  if (sessionIndex < 0) return;
  setAsideSessionTurns(surface, sessionIndex, kept);
  if (surface.sessionIndex === sessionIndex) {
    surface.confirmReset = null;
    surface.turnCursor = Math.max(0, kept.length - 1);
    surface.deleteUndo = null;
    surface.scrollTop = null;
  }
  applySessionResponse(state, surface, result, context.cache);
}

async function clearCurrentSession(
  state: RuntimeState,
  surface: AsideSessionSurfaceState,
  context: AsideContext,
  task: ActionTask
): Promise<void> {
  const session = currentAsideSession(surface);
  if (session === null) return;
  const sessionId = session.id;
  const method = context.source.api.clearAsideSession;
  if (method === undefined) {
    throw new Error("This transport cannot clear an Aside session.");
  }
  const result = await method({
    storyId: surface.storyId,
    sessionId: session.id,
    anchor: currentAnchor(surface)
  });
  if (!taskCurrent(state, surface, task)) return;
  const sessionIndex = surface.sessions.findIndex((entry) => entry.id === sessionId);
  if (sessionIndex < 0) return;
  setAsideSessionTurns(surface, sessionIndex, []);
  if (surface.sessionIndex === sessionIndex) {
    surface.confirmReset = null;
    surface.turnCursor = 0;
    surface.focus = "composer";
  }
  applySessionResponse(state, surface, result, context.cache);
}

async function retakeAside(
  state: RuntimeState,
  surface: AsideSessionSurfaceState,
  context: AsideContext,
  task: ActionTask
): Promise<void> {
  const session = currentAsideSession(surface);
  const turn = currentAsideTurns(surface)[surface.turnCursor];
  if (session === null || turn === undefined
    || surface.turnCursor !== session.turns.length - 1) return;
  const method = context.source.api.retakeAside;
  if (method === undefined) {
    throw new Error("This transport cannot retake an Aside answer.");
  }
  if (state.abort !== null) return;
  const current = () => state.aside === surface
    && state.payload.id === surface.storyId
    && task.owns()
    && task.storyCurrent();
  surface.busy = true;
  surface.inflightQuestion = turn.q;
  surface.streamText = "";
  surface.streamThoughts = "";
  surface.streamThoughtTokens = 0;
  surface.streamPhase = "thinking";
  surface.streamHidden = false;
  const controller = new AbortController();
  const active = {
    kind: "generation" as const,
    controller,
    stopInteractionVersion: null as number | null,
    askInteractionVersion: state.interactionVersion
  };
  state.abort = active;
  try {
    const result = await method({
      storyId: surface.storyId,
      sessionId: session.id,
      turnIndex: surface.turnCursor,
      anchor: currentAnchor(surface)
    }, (text) => {
      if (!current()) return;
      surface.streamPhase = "writing";
      surface.streamText += text;
      context.repaint?.();
    }, {
      onReasoning: (delta) => {
        if (!current()) return;
        surface.streamThoughts += delta.text;
        surface.streamThoughtTokens = Math.max(surface.streamThoughtTokens, delta.tokenCount);
        context.repaint?.();
      },
      onReasoningStopped: (text) => {
        if (!current()) return;
        surface.streamThoughts += text;
        context.repaint?.();
      }
    }, controller.signal);
    if (!current()) return;
    // A terminal response is durable even when Stop aborted the transport.
    // Thoughts visibility is display-only and may advance interactionVersion
    // after Stop, so do not use that version to discard a committed retake.
    if (result === null) return;
    recordNotice(
      state.notices,
      "toast",
      `Aside retake replaced the previous answer:\n${turn.a}`,
      "plain",
      state.now
    );
    applySessionResponse(state, surface, result, context.cache);
  } finally {
    if (state.abort === active) state.abort = null;
    if (current()) {
      clearAsideStream(surface);
      surface.busy = false;
      context.repaint?.();
    }
  }
}

/** Handle v2-only actions. Return true when the key was consumed. */
export async function asideV2KeyAction(
  resolved: ResolvedKey,
  state: RuntimeState,
  surface: AsideSurfaceState,
  context: AsideContext
): Promise<boolean> {
  if (!isAsideV2(surface)) return false;
  if (resolved.action === "aside-undo-delete") {
    if (undoAsideDelete(surface)) state.toast = "turn restored";
    return true;
  }
  if (surface.deleteUndo !== null && state.backendTask === null) {
    const undo = surface.deleteUndo;
    // The undo is a pre-commit affordance. Remove it before `run` repaints
    // and keep the captured turn private until the request settles.
    surface.deleteUndo = null;
    context.backend.observe(context.backend.run("deleting Aside turn", (task) =>
      commitAsideDelete(state, surface, context.source.api, context.cache, task, undo)
    ));
  }
  if (surface.useMenu !== null) return false;
  if (resolved.action === "cancel" && surface.confirmReset !== null) {
    surface.confirmReset = null;
    return true;
  }
  if (surface.confirmReset !== null) {
    if (surface.confirmReset.turnIndex < 0 && resolved.action === "send") {
      surface.composer.text = "";
      context.backend.observe(context.backend.run("clearing Aside session", (task) =>
        clearCurrentSession(state, surface, context, task)
      ));
      return true;
    }
    if (resolved.action !== "aside-reset" && resolved.action !== "cancel") {
      surface.confirmReset = null;
    }
  }
  if (resolved.action === "toggle-thought") {
    const changed = toggleAsideThoughts(surface);
    if (changed) {
      const active = state.abort?.kind === "generation" ? state.abort : null;
      // Thoughts visibility is display-only. Preserve a stopped ask's
      // question-restoration fence across this interaction, while leaving
      // every real composer edit subject to the normal stale guard.
      if (active !== null && active.stopInteractionVersion !== null) {
        active.stopInteractionVersion = state.interactionVersion;
      }
      const nextConfig: RuntimeState["config"] = {
        ...state.config,
        asideThoughts: surface.thoughtsVisible ? "show" : "hide"
      };
      state.config = nextConfig;
      context.source.config = nextConfig;
      if (!state.demo) saveConfig(nextConfig);
    }
    return changed;
  }
  const displayScroll = resolved.action === "scroll-line-down"
    || resolved.action === "scroll-line-up"
    || resolved.action === "scroll-down"
    || resolved.action === "scroll-up";
  // Streaming owns editing and navigation, but scrolling only changes the
  // displayed history window and remains safe while the answer grows.
  if (surface.busy && resolved.action !== "cancel" && !displayScroll) return true;
  if (resolved.action === "aside-session-next") return cycleAsideSession(surface, 1);
  if (resolved.action === "aside-session-previous") return cycleAsideSession(surface, -1);
  if (resolved.action === "aside-new-session") return newAsideSession(surface);
  if ((resolved.action === "cursor-left" || resolved.action === "cursor-right")
    && surface.composer.text.length === 0
    && currentAsideTurns(surface).length === 0
    && surface.sessions.length > 1) {
    return cycleAsideSession(surface, resolved.action === "cursor-right" ? 1 : -1);
  }
  if (resolved.action === "focus-next" || resolved.action === "focus-previous") {
    if (surface.focus !== "turns" && surface.focus !== "notes") return false;
    const turns = currentAsideTurns(surface);
    if (turns.length === 0) return true;
    surface.turnCursor = Math.max(0, Math.min(
      turns.length - 1,
      surface.turnCursor + (resolved.action === "focus-next" ? 1 : -1)
    ));
    revealFocusedTurn(surface, context);
    surface.confirmReset = null;
    return true;
  }
  if (resolved.action === "open-selected" || resolved.action === "apply") {
    if (surface.focus !== "turns" && surface.focus !== "notes") return false;
    return false;
  }
  if (resolved.action === "aside-delete") {
    if (state.backendTask !== null) return true;
    if (removeTurn(surface)) state.toast = "▸ deleted 1 turn · u undoes";
    return true;
  }
  if (resolved.action === "aside-reset") {
    if (surface.turnCursor >= currentAsideTurns(surface).length - 1) return true;
    if (surface.confirmReset?.turnIndex !== surface.turnCursor) {
      surface.confirmReset = { turnIndex: surface.turnCursor };
      return true;
    }
    context.backend.observe(context.backend.run("resetting Aside session", (task) =>
      resetAside(state, surface, context, task)
    ));
    return true;
  }
  if (resolved.action === "aside-retake") {
    context.backend.observe(context.backend.run("retaking Aside answer", (task) =>
      retakeAside(state, surface, context, task)
    ));
    return true;
  }
  const currentSession = currentAsideSession(surface);
  const emptyCurrentBucket = currentSession === null || currentSession.turns.length === 0;
  const orderedAnchors = orderAsideAnchors(surface.anchors);
  const soleAnchorIsCurrent = orderedAnchors.length === 1 && (
    orderedAnchors[0]!.unanchored === true
      ? surface.anchor === null
      : surface.anchor !== null
        && orderedAnchors[0]!.partId === surface.anchor.partId
        && orderedAnchors[0]!.takeId === surface.anchor.takeId
  );
  const bracketHopAction = resolved.action === "input"
    && surface.composer.text.length === 0
    && emptyCurrentBucket
    && (orderedAnchors.length > 1 || (orderedAnchors.length === 1 && !soleAnchorIsCurrent))
    && (resolved.text === "[" || resolved.text === "]")
    ? resolved.text === "[" ? "aside-anchor-previous" : "aside-anchor-next"
    : null;
  const anchorAction = bracketHopAction
    ?? (resolved.action === "aside-anchor-next" || resolved.action === "aside-anchor-previous"
      ? resolved.action : null);
  if (anchorAction !== null) {
    const currentAnchorIndex = orderedAnchors.findIndex((entry) =>
      entry.unanchored === true
        ? surface.anchor === null
        : surface.anchor !== null
          && entry.partId === surface.anchor.partId
          && entry.takeId === surface.anchor.takeId
    );
    if (orderedAnchors.length === 0
      || (orderedAnchors.length === 1 && currentAnchorIndex === 0)) return true;
    const delta = anchorAction === "aside-anchor-next" ? 1 : -1;
    // A surface can retain an anchor that the current presence projection no
    // longer contains. Start just before the first entry for `]`, and just
    // after the last entry for `[`, rather than cycling from the stale index.
    const baseIndex = currentAnchorIndex >= 0
      ? currentAnchorIndex
      : delta > 0 ? -1 : 0;
    const nextAnchorIndex = (baseIndex + delta + orderedAnchors.length)
      % orderedAnchors.length;
    const anchor = orderedAnchors[nextAnchorIndex]!;
    const getAsideV2 = context.source.api.getAsideV2;
    if (getAsideV2 === undefined) {
      throw new Error("This transport cannot hop Aside sessions.");
    }
    const requestedAnchor = anchor.unanchored === true
      ? null : { partId: anchor.partId, takeId: anchor.takeId };
    context.backend.observe(context.backend.run("hopping Aside sessions", async (task) => {
      const response = await getAsideV2({
        storyId: surface.storyId,
        anchor: requestedAnchor
      });
      if (response === null || !taskInteractionCurrent(state, surface, task)) return;
      const model = asideSessionsFromResponse(response, requestedAnchor);
      surface.sessions = model.sessions;
      surface.anchor = requestedAnchor;
      surface.sessionIndex = Math.max(0, model.sessions.length - 1);
      surface.turnCursor = Math.max(0, currentAsideTurns(surface).length - 1);
      surface.anchors = model.anchors.length > 0
        ? model.anchors : surface.anchors;
      surface.anchorIndex = asideHopAnchorIndex(
        surface.anchors,
        surface.anchor
      );
      surface.focus = currentAsideTurns(surface).length > 0 ? "turns" : "composer";
      surface.scrollTop = null;
    }));
    return true;
  }
  if (resolved.action === "aside-go-anchor") {
    const anchor = asideHopTarget(
      surface.anchors,
      surface.anchorIndex
    );
    if (anchor === null) return true;
    if (anchor.unanchored === true) return true;
    const switchLine = context.source.api.switchLine as unknown as (
      storyId: string,
      nodeId: string
    ) => Promise<RuntimeState["payload"]>;
    context.backend.observe(context.backend.run("switching to Aside take", async (task) => {
      const payload = await switchLine(surface.storyId, anchor.takeId);
      if (!taskInteractionCurrent(state, surface, task)) return;
      let view;
      if (context.cache === undefined) {
        state.payload = payload;
        view = createStoryViewModel(state.payload);
      } else {
        view = adoptSameStoryPayload(state, payload, context.cache);
      }
      const focusIndex = rowIndexForNode(view, anchor.takeId);
      if (focusIndex >= 0) {
        state.focusIndex = focusIndex;
        followStoryViewport(state);
      }
      surface.busy = false;
      state.aside = null;
      state.mode = "NAV";
    }));
    return true;
  }
  if (resolved.action === "send" && surface.composer.text.trim() === "/clear") {
    surface.composer.text = "";
    if (surface.confirmReset === null) {
      surface.confirmReset = { turnIndex: -1 };
      return true;
    }
    context.backend.observe(context.backend.run("clearing Aside session", (task) =>
      clearCurrentSession(state, surface, context, task)
    ));
    return true;
  }
  return false;
}
