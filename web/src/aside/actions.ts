import type { AsideStreamCallbacks, StoryApi } from "../../../client/api.js";
import type { AsideAnchor } from "../../../shared/aside-anchor.js";
import type { AsideAnchorView } from "../../../shared/aside-hop-model.js";
import type {
  AsideAskResponse,
  AsideReadResponse,
  AsideSessionMutationResponse,
  AsideSessionResponse
} from "../../../shared/aside-transport.js";
import type { StoryPayload } from "../../../shared/types.js";
import { openStory } from "../chapters/model.js";
import { runBusyToast } from "../app/run-lock.js";
import { recordNotice } from "../app/notices.js";
import type { AppState } from "../app/state.js";
import type { Store } from "../app/store.js";
import { errorMessage, pushToast } from "../app/toasts.js";
import { createRafFlushScheduler } from "../generation/stream-buffer.js";
import type { PanelActions } from "../panel/actions.js";
import { manuscriptModelOf } from "../story/manuscript-model.js";
import { NOT_CONNECTED_TOAST } from "../story/story-policy.js";
import type { StoryActions } from "../story/actions.js";
import { effectiveFocusedPartId } from "../story/state.js";
import {
  anchorOfPart,
  anchorOfView,
  anchorViews,
  anchorViewsOfPayload,
  labelFromViews,
  labelOfPart,
  neighbourEntry
} from "./model.js";
import {
  currentSession,
  sameAnchor,
  type AsideAnchorLabel,
  type AsideRun,
  type AsideState,
  type AsideSurface
} from "./state.js";

export const ASIDE_UNAVAILABLE_TOAST = "Aside is not available on this server.";
export const RETAKE_GONE_TOAST = "That Aside answer is no longer there to retake. Your question is back in the box.";

export interface AsideActions {
  /** `a` and the palette: Aside on the focused part's take (or on `partId`'s,
   * from a part's mark), in the panel. */
  open(partId?: string): void;
  /** Hides the panel. The question drafts stay, and a running answer keeps going. */
  close(): void;
  /** Goes to another anchor's sessions. */
  hop(entry: AsideAnchorView): void;
  /** `[` and `]`. */
  hopBy(delta: 1 | -1): void;
  cycleSession(delta: 1 | -1): void;
  newSession(): void;
  selectTurn(index: number): void;
  moveTurn(delta: 1 | -1): void;
  setDraft(text: string): void;
  /** Asks the question in the box. */
  ask(): Promise<void>;
  /** Writes the last answer again, from the same question. */
  retake(): Promise<void>;
  /** Opens the last answer's question for editing. */
  startRetake(): void;
  setRetakeText(text: string): void;
  cancelRetake(): void;
  /** Writes the last answer again, from the edited question. */
  submitRetake(): Promise<void>;
  deleteTurn(turnIndex: number): Promise<void>;
  /** Drops every turn after `turnIndex`. */
  resetTo(turnIndex: number): Promise<void>;
  clearSession(): Promise<void>;
  /** Moves the story to the anchor's take. */
  goToAnchor(): void;
  /** Asks for a yes before delete, reset or clear. */
  requestConfirm(kind: "delete" | "reset" | "clear"): void;
  dismissConfirm(): void;
  /** The yes: runs what `requestConfirm` asked for. */
  acceptConfirm(): Promise<void>;
  /** Esc and Stop. Returns whether there was an ask to stop. */
  stop(): boolean;
}

type Update = (aside: AsideState) => AsideState;

/** The anchors after a payload's presence summary: its counts win, and the
 * numbers it leaves out stay from the anchors that were there. */
function reconcileAnchors(previous: readonly AsideAnchorView[], payload: StoryPayload): readonly AsideAnchorView[] {
  const next = anchorViewsOfPayload(payload);
  if (next === null) return previous;
  return next.map((view) => {
    const old = previous.find((entry) => entry.unanchored !== true && entry.partId === view.partId && entry.takeId === view.takeId);
    if (old === undefined) return view;
    return {
      ...view,
      ...(view.partNumber === undefined && old.partNumber !== undefined ? { partNumber: old.partNumber } : {}),
      ...(view.takeIndex === undefined && old.takeIndex !== undefined ? { takeIndex: old.takeIndex } : {}),
      ...(view.takeCount === undefined && old.takeCount !== undefined ? { takeCount: old.takeCount } : {})
    };
  });
}

function withSession(surface: AsideSurface, session: AsideSessionResponse): { sessions: readonly AsideSessionResponse[]; index: number } {
  const at = surface.sessions.findIndex((entry) => entry.id === session.id);
  if (at < 0) return { sessions: [...surface.sessions, session], index: surface.sessions.length };
  const sessions = surface.sessions.slice();
  sessions[at] = session;
  return { sessions, index: at };
}

export function createAsideActions(
  store: Store<AppState>,
  deps: { readonly story: Pick<StoryActions, "adoptPayload" | "switchLine">; readonly panel: Pick<PanelActions, "open" | "close"> }
): AsideActions {
  let controller: AbortController | null = null;
  /** Raised whenever the surface is replaced, so a slow read cannot land on a newer one. */
  let epoch = 0;

  const set = (update: Update): void =>
    store.set((state) => {
      const aside = update(state.aside);
      return aside === state.aside ? state : { ...state, aside };
    });
  const setSurface = (update: (surface: AsideSurface) => AsideSurface): void =>
    set((aside) => (aside.surface === null ? aside : { ...aside, surface: update(aside.surface) }));
  const setRun = (update: (run: AsideRun) => AsideRun): void =>
    set((aside) => (aside.run === null ? aside : { ...aside, run: update(aside.run) }));

  /** Why a question or a change may not start now, or `null`. */
  function refusal(storyId: string): string | null {
    const state = store.get();
    if (state.connection.kind !== "connected") return NOT_CONNECTED_TOAST;
    return runBusyToast(state, storyId);
  }

  function lastTurn(session: AsideSessionResponse | null): number {
    return Math.max(0, (session?.turns.length ?? 0) - 1);
  }

  function applyRead(response: AsideReadResponse, anchor: AsideAnchor | null, fallback: AsideAnchorLabel): void {
    const anchors = anchorViews(response);
    setSurface((surface) => {
      const sessions = response.sessions;
      const sessionIndex = Math.max(0, sessions.length - 1);
      return {
        ...surface,
        load: "ready",
        sessions,
        anchors: anchors.length > 0 ? anchors : surface.anchors,
        label: labelFromViews(anchors, anchor) ?? fallback,
        sessionIndex,
        turnCursor: lastTurn(sessions[sessionIndex] ?? null)
      };
    });
  }

  async function read(storyId: string, anchor: AsideAnchor | null, api: StoryApi, fallback: AsideAnchorLabel): Promise<boolean> {
    const mine = ++epoch;
    try {
      const response = await api.getAsideV2?.({ storyId, anchor });
      if (mine !== epoch) return false;
      if (response === undefined || response === null) {
        pushToast(store, ASIDE_UNAVAILABLE_TOAST);
        return false;
      }
      applyRead(response, anchor, fallback);
      return true;
    } catch (error) {
      if (mine === epoch) {
        setSurface((surface) => ({ ...surface, load: "failed" }));
        pushToast(store, `Aside failed to load: ${errorMessage(error)}`);
      }
      return false;
    }
  }

  /** After any failure: the session is read again, and the story too, because
   * a failed call can still have moved the story's version. */
  async function recover(storyId: string, api: StoryApi): Promise<void> {
    const surface = store.get().aside.surface;
    const reloadStory = api.loadStory(storyId)
      .then((payload) => { deps.story.adoptPayload(storyId, payload); })
      .catch(() => undefined);
    if (surface !== null && surface.storyId === storyId) {
      const anchor = surface.anchor;
      const mine = epoch;
      try {
        const response = await api.getAsideV2?.({ storyId, anchor });
        if (response !== undefined && response !== null && mine === epoch) {
          const current = store.get().aside.surface;
          const sameSession = current === null ? undefined : currentSession(current)?.id;
          const anchors = anchorViews(response);
          setSurface((now) => {
            const at = Math.max(0, response.sessions.findIndex((entry) => entry.id === sameSession));
            const sessionIndex = sameSession === undefined || at < 0 ? Math.max(0, response.sessions.length - 1) : at;
            return {
              ...now,
              load: "ready",
              sessions: response.sessions,
              anchors: anchors.length > 0 ? anchors : now.anchors,
              sessionIndex,
              turnCursor: Math.min(now.turnCursor, lastTurn(response.sessions[sessionIndex] ?? null))
            };
          });
        }
      } catch {
        // The failure that brought us here already has its toast.
      }
    }
    await reloadStory;
  }

  /** Puts the session a call returned into the surface, and adopts its story. */
  function applySession(
    storyId: string,
    session: AsideAskResponse | AsideSessionMutationResponse,
    cursor: (session: AsideSessionResponse) => number
  ): void {
    if (session.payload !== undefined) deps.story.adoptPayload(storyId, session.payload);
    const { payload, ...view } = session;
    setSurface((surface) => {
      if (surface.storyId !== storyId || !sameAnchor(view.anchor, surface.anchor)) return surface;
      const merged = withSession(surface, view);
      return {
        ...surface,
        sessions: merged.sessions,
        sessionIndex: merged.index,
        turnCursor: cursor(view),
        anchors: payload === undefined ? surface.anchors : reconcileAnchors(surface.anchors, payload)
      };
    });
  }

  /** What an ask that did not land gives back: the question goes into the box.
   * A newer text in the box stays below it, so nothing typed is lost. */
  function restoreQuestion(storyId: string, question: string): void {
    if (question.length === 0) return;
    set((aside) => {
      const typed = aside.drafts[storyId] ?? "";
      const text = typed.trim().length === 0 ? question : `${question}\n${typed}`;
      return { ...aside, drafts: { ...aside.drafts, [storyId]: text } };
    });
  }

  /** One ask or retake: the streaming run, from the lock to its end. */
  async function stream(
    kind: "ask" | "retake",
    question: string,
    call: (api: StoryApi, onDelta: (text: string) => void, callbacks: AsideStreamCallbacks, signal: AbortSignal) => Promise<AsideAskResponse | null>,
    landed: (session: AsideAskResponse) => void
  ): Promise<boolean> {
    const state = store.get();
    const open = openStory(state);
    const surface = state.aside.surface;
    if (open === null || surface === null || surface.storyId !== open.storyId || surface.load !== "ready") return false;
    const toast = refusal(open.storyId);
    if (toast !== null) {
      pushToast(store, toast);
      return false;
    }
    const { storyId, api } = open;
    const mine = new AbortController();
    controller = mine;
    let text = "";
    const scheduler = createRafFlushScheduler();
    set((aside) => ({
      ...aside,
      run: { storyId, storyTitle: open.payload.title, kind, question, text: "", phase: "waiting", stopping: false }
    }));
    try {
      const session = await call(
        api,
        (delta) => {
          text += delta;
          scheduler.schedule(() => setRun((run) => ({ ...run, text })));
        },
        { onPhase: (phase) => setRun((run) => (run.phase === phase ? run : { ...run, phase })) },
        mine.signal
      );
      scheduler.cancel();
      if (session === null) {
        // Stopped before anything was written: nothing is saved.
        set((aside) => ({ ...aside, run: null }));
        return false;
      }
      landed(session);
      set((aside) => ({ ...aside, run: null }));
      if (mine.signal.aborted) pushToast(store, "Aside stopped. The answer is kept.");
      return true;
    } catch (error) {
      scheduler.cancel();
      set((aside) => ({ ...aside, run: null }));
      // A Stop that surfaces as an error is not a failure to report.
      if (!mine.signal.aborted) pushToast(store, errorMessage(error));
      await recover(storyId, api);
      return false;
    } finally {
      if (controller === mine) controller = null;
    }
  }

  /** A short session change (delete, reset, clear): locked like an ask, but not stoppable. */
  async function change(
    call: (api: StoryApi) => Promise<AsideSessionMutationResponse>,
    cursor: (session: AsideSessionResponse) => number
  ): Promise<void> {
    const state = store.get();
    const open = openStory(state);
    const surface = state.aside.surface;
    if (open === null || surface === null || surface.storyId !== open.storyId) return;
    const toast = refusal(open.storyId);
    if (toast !== null) {
      pushToast(store, toast);
      return;
    }
    const { storyId, api } = open;
    set((aside) => ({
      ...aside,
      run: { storyId, storyTitle: open.payload.title, kind: "change", question: "", text: "", phase: "waiting", stopping: false }
    }));
    try {
      const session = await call(api);
      applySession(storyId, session, cursor);
      set((aside) => ({ ...aside, run: null }));
    } catch (error) {
      set((aside) => ({ ...aside, run: null }));
      pushToast(store, errorMessage(error));
      await recover(storyId, api);
    }
  }

  function target(): { surface: AsideSurface; session: AsideSessionResponse; storyId: string } | null {
    const surface = store.get().aside.surface;
    const session = surface === null ? null : currentSession(surface);
    return surface === null || session === null ? null : { surface, session, storyId: surface.storyId };
  }

  function moveSession(delta: 1 | -1): void {
    setSurface((surface) => {
      const count = surface.sessions.length;
      if (count < 2) return surface;
      const sessionIndex = (surface.sessionIndex + delta + count) % count;
      return { ...surface, sessionIndex, turnCursor: lastTurn(surface.sessions[sessionIndex] ?? null) };
    });
  }

  async function goTo(entry: AsideAnchorView): Promise<void> {
    const state = store.get();
    const open = openStory(state);
    const surface = state.aside.surface;
    if (open === null || surface === null) return;
    const anchor = anchorOfView(entry);
    if (sameAnchor(anchor, surface.anchor)) return;
    if (state.aside.run !== null) {
      pushToast(store, runBusyToast(state, open.storyId) ?? "Aside is answering. Esc stops it first.");
      return;
    }
    const label = { ...(entry.partNumber === undefined ? {} : { partNumber: entry.partNumber }), ...(entry.takeIndex === undefined ? {} : { takeIndex: entry.takeIndex }), ...(entry.takeCount === undefined ? {} : { takeCount: entry.takeCount }) };
    setSurface((now) => ({ ...now, anchor, label, load: "loading", sessions: [], sessionIndex: 0, turnCursor: 0 }));
    await read(open.storyId, anchor, open.api, label);
  }

  const actions: AsideActions = {
    open: (onPart) => {
      const state = store.get();
      const open = openStory(state);
      if (open === null) return;
      const run = state.aside.run;
      if (run !== null) {
        // The answer keeps coming where it began; only the panel comes back.
        if (run.storyId === open.storyId) deps.panel.open("aside");
        else pushToast(store, runBusyToast(state, open.storyId) ?? "Aside is answering. Esc stops it first.");
        return;
      }
      if (open.api.getAsideV2 === undefined) {
        pushToast(store, ASIDE_UNAVAILABLE_TOAST);
        return;
      }
      const partId = onPart ?? (state.story.kind === "loaded" ? effectiveFocusedPartId(state.story) : null);
      const part = partId === null ? undefined : manuscriptModelOf(open.payload).parts.find((candidate) => candidate.id === partId);
      const anchor = part === undefined ? null : anchorOfPart(part.id);
      const label = part === undefined ? {} : labelOfPart(part);
      set((aside) => ({
        ...aside,
        surface: {
          storyId: open.storyId,
          storyTitle: open.payload.title,
          anchor,
          label,
          load: "loading",
          sessions: [],
          anchors: anchorViewsOfPayload(open.payload) ?? [],
          sessionIndex: 0,
          turnCursor: 0
        }
      }));
      deps.panel.open("aside");
      void read(open.storyId, anchor, open.api, label);
    },

    close: () => deps.panel.close(),

    hop: (entry) => { void goTo(entry); },

    hopBy: (delta) => {
      const surface = store.get().aside.surface;
      const entry = surface === null ? null : neighbourEntry(surface, delta);
      if (entry !== null) void goTo(entry);
    },

    cycleSession: (delta) => {
      if (store.get().aside.run === null) moveSession(delta);
    },

    newSession: () => {
      if (store.get().aside.run !== null) return;
      setSurface((surface) => {
        const empty = surface.sessions.findIndex((session) => session.turns.length === 0);
        if (empty >= 0) return { ...surface, sessionIndex: empty, turnCursor: 0 };
        const session: AsideSessionResponse = {
          schemaVersion: 2,
          id: `session-${crypto.randomUUID()}`,
          anchor: surface.anchor,
          title: "new session",
          turns: []
        };
        return { ...surface, sessions: [...surface.sessions, session], sessionIndex: surface.sessions.length, turnCursor: 0 };
      });
    },

    selectTurn: (index) => setSurface((surface) => {
      const last = lastTurn(currentSession(surface));
      const turnCursor = Math.max(0, Math.min(last, index));
      return turnCursor === surface.turnCursor ? surface : { ...surface, turnCursor };
    }),

    moveTurn: (delta) => setSurface((surface) => {
      const turnCursor = Math.max(0, Math.min(lastTurn(currentSession(surface)), surface.turnCursor + delta));
      return turnCursor === surface.turnCursor ? surface : { ...surface, turnCursor };
    }),

    setDraft: (text) => {
      const storyId = store.get().aside.surface?.storyId;
      if (storyId === undefined) return;
      set((aside) => {
        if ((aside.drafts[storyId] ?? "") === text) return aside;
        const drafts = { ...aside.drafts };
        if (text.length === 0) delete drafts[storyId];
        else drafts[storyId] = text;
        return { ...aside, drafts };
      });
    },

    ask: async () => {
      const aside = store.get().aside;
      const surface = aside.surface;
      if (surface === null || surface.load !== "ready") return;
      const question = (aside.drafts[surface.storyId] ?? "").trim();
      if (question.length === 0) return;
      const session = currentSession(surface);
      const anchor = surface.anchor;
      const storyId = surface.storyId;
      const toast = refusal(storyId);
      if (toast !== null) {
        pushToast(store, toast);
        return;
      }
      // The box empties as the question goes; Stop with no answer, or a
      // failure, puts it back.
      set((now) => {
        const drafts = { ...now.drafts };
        delete drafts[storyId];
        return { ...now, drafts };
      });
      const sent = await stream(
        "ask",
        question,
        (api, onDelta, callbacks, signal) => {
          if (api.askAsideV2 === undefined) throw new Error(ASIDE_UNAVAILABLE_TOAST);
          return api.askAsideV2(
            { storyId, question, anchor, ...(session === null ? {} : { sessionId: session.id }) },
            onDelta,
            callbacks,
            signal
          );
        },
        (result) => applySession(storyId, result, (view) => lastTurn(view))
      );
      if (!sent) restoreQuestion(storyId, question);
    },

    retake: async () => {
      const found = target();
      if (found === null || found.surface.turnCursor !== found.session.turns.length - 1) return;
      const turn = found.session.turns[found.surface.turnCursor];
      if (turn === undefined) return;
      const { storyId, session, surface } = found;
      const turnIndex = found.surface.turnCursor;
      await stream(
        "retake",
        turn.q,
        (api, onDelta, callbacks, signal) => {
          if (api.retakeAside === undefined) throw new Error(ASIDE_UNAVAILABLE_TOAST);
          return api.retakeAside({ storyId, sessionId: session.id, turnIndex, anchor: surface.anchor }, onDelta, callbacks, signal);
        },
        (result) => {
          recordNotice(store, "toast", `Aside retake replaced the previous answer:\n${turn.a}`);
          applySession(storyId, result, (view) => lastTurn(view));
        }
      );
    },

    startRetake: () => {
      const found = target();
      if (found === null || store.get().aside.run !== null) return;
      const turnIndex = found.surface.turnCursor;
      const turn = found.session.turns[turnIndex];
      if (turn === undefined || turnIndex !== found.session.turns.length - 1) return;
      set((aside) => ({
        ...aside,
        retake: aside.retake !== null && aside.retake.sessionId === found.session.id && aside.retake.turnIndex === turnIndex
          ? aside.retake
          : { storyId: found.storyId, sessionId: found.session.id, turnIndex, text: turn.q }
      }));
    },

    setRetakeText: (text) => set((aside) => (aside.retake === null || aside.retake.text === text ? aside : { ...aside, retake: { ...aside.retake, text } })),

    cancelRetake: () => set((aside) => (aside.retake === null ? aside : { ...aside, retake: null })),

    submitRetake: async () => {
      const draft = store.get().aside.retake;
      const found = target();
      if (draft === null) return;
      const question = draft.text.trim();
      if (question.length === 0) return;
      if (found === null || found.session.id !== draft.sessionId
        || draft.turnIndex !== found.session.turns.length - 1 || found.surface.turnCursor !== draft.turnIndex) {
        // The turn is gone. The edited question moves to the ask box.
        set((aside) => ({ ...aside, retake: null }));
        restoreQuestion(draft.storyId, question);
        pushToast(store, RETAKE_GONE_TOAST);
        return;
      }
      const { storyId, session, surface } = found;
      const old = session.turns[draft.turnIndex];
      const landed = await stream(
        "retake",
        question,
        (api, onDelta, callbacks, signal) => {
          if (api.retakeAside === undefined) throw new Error(ASIDE_UNAVAILABLE_TOAST);
          return api.retakeAside({ storyId, sessionId: session.id, turnIndex: draft.turnIndex, anchor: surface.anchor, question }, onDelta, callbacks, signal);
        },
        (result) => {
          if (old !== undefined) recordNotice(store, "toast", `Aside retake replaced the previous answer:\n${old.a}`);
          applySession(storyId, result, (view) => lastTurn(view));
        }
      );
      // A stop or a failure keeps the edited question where it is.
      if (landed) set((aside) => ({ ...aside, retake: null }));
    },

    deleteTurn: async (turnIndex) => {
      const found = target();
      if (found === null) return;
      const { storyId, session, surface } = found;
      await change(
        (api) => {
          if (api.deleteAsideTurn === undefined) throw new Error(ASIDE_UNAVAILABLE_TOAST);
          return api.deleteAsideTurn({ storyId, sessionId: session.id, turnIndex, anchor: surface.anchor });
        },
        (view) => Math.min(turnIndex, lastTurn(view))
      );
    },

    resetTo: async (turnIndex) => {
      const found = target();
      if (found === null) return;
      const { storyId, session, surface } = found;
      await change(
        (api) => {
          if (api.resetAside === undefined) throw new Error(ASIDE_UNAVAILABLE_TOAST);
          return api.resetAside({ storyId, sessionId: session.id, turnIndex, anchor: surface.anchor });
        },
        (view) => Math.min(turnIndex, lastTurn(view))
      );
    },

    clearSession: async () => {
      const found = target();
      if (found === null) return;
      const { storyId, session, surface } = found;
      await change(
        (api) => {
          if (api.clearAsideSession === undefined) throw new Error(ASIDE_UNAVAILABLE_TOAST);
          return api.clearAsideSession({ storyId, sessionId: session.id, anchor: surface.anchor });
        },
        () => 0
      );
    },

    requestConfirm: (kind) => {
      const found = target();
      if (found === null || store.get().aside.run !== null) return;
      const turnIndex = found.surface.turnCursor;
      if (kind === "clear" ? found.session.turns.length === 0
        : found.session.turns[turnIndex] === undefined || (kind === "reset" && turnIndex >= found.session.turns.length - 1)) return;
      set((aside) => ({ ...aside, confirm: { kind, turnIndex } }));
    },

    dismissConfirm: () => set((aside) => (aside.confirm === null ? aside : { ...aside, confirm: null })),

    acceptConfirm: async () => {
      const confirm = store.get().aside.confirm;
      if (confirm === null) return;
      set((aside) => ({ ...aside, confirm: null }));
      if (confirm.kind === "delete") await actions.deleteTurn(confirm.turnIndex);
      else if (confirm.kind === "reset") await actions.resetTo(confirm.turnIndex);
      else await actions.clearSession();
    },

    goToAnchor: () => {
      const surface = store.get().aside.surface;
      if (surface === null || surface.anchor === null) return;
      if (deps.story.switchLine(surface.anchor.takeId) && !window.matchMedia("(min-width: 1200px)").matches) deps.panel.close();
    },

    stop: () => {
      const run = store.get().aside.run;
      if (run === null || run.kind === "change" || run.stopping || controller === null) return false;
      setRun((current) => ({ ...current, stopping: true }));
      controller.abort();
      return true;
    }
  };
  return actions;
}
