import { DEFAULT_INSTRUCTION } from "../../../shared/continuation-plan.js";
import { resolveRewriteRange } from "../../../shared/rewrite-target.js";
import type { GenerationActions } from "../generation/actions.js";
import { createImageActions, type ImageActions } from "../images/actions.js";
import type { AppState } from "../app/state.js";
import type { Store } from "../app/store.js";
import { pushToast } from "../app/toasts.js";
import {
  NOT_CONNECTED_TOAST,
  RETAKE_GONE_TOAST,
  partActionRefusal
} from "../story/part-policy.js";
import { runBusyToast } from "../app/run-lock.js";
import { openPart } from "../story/state.js";
import type { StoryActions } from "../story/actions.js";
import { focusComposer } from "./dom.js";
import { createDirectDraft, createRetakeDraft, type DraftHost } from "./draft-handle.js";
import {
  composeDraftOf,
  isBrowsingHistory,
  visibleComposeText,
  type ComposeState,
  type RewriteDraft,
  type StoryComposeDraft
} from "./state.js";

export interface ComposeActionDependencies {
  readonly story: Pick<StoryActions, "focusPart">;
  readonly generation: Pick<GenerationActions, "continue" | "rewrite">;
}

export interface ComposeActions extends ImageActions {
  /** The writer typed: replaces the text the box shows. */
  setText(storyId: string, text: string): void;
  /** `R`: opens retake mode for this part, filled with its direction. */
  startRetake(partId: string): void;
  /** "Rewrite selection": opens the composer in rewrite mode for this passage
   * of the part, with an empty instruction. */
  startRewrite(partId: string, range: RewriteDraft): void;
  /** Closes retake mode. The Direct text comes back. */
  cancelRetake(storyId: string): void;
  /** Sends the box. Returns whether it was sent; a refusal shows a toast and
   * keeps the draft in the box. */
  submit(storyId: string): boolean;
  /** Walks the history: -1 older, 1 newer. */
  historyMove(storyId: string, direction: -1 | 1): void;
}

/** Why a send is refused right now, or `null`. Every wording keeps the
 * promise "draft kept". The generation wording is the policy's own. */
function submitRefusal(state: AppState, storyId: string): string | null {
  if (state.connection.kind !== "connected") return `${NOT_CONNECTED_TOAST} Draft kept.`;
  const busy = runBusyToast(state, storyId);
  return busy === null ? null : `${busy} Draft kept.`;
}

export function createComposeActions(store: Store<AppState>, deps: ComposeActionDependencies): ComposeActions {
  const writeCompose = (update: (compose: ComposeState) => ComposeState): void =>
    store.set((state) => {
      const compose = update(state.compose);
      return compose === state.compose ? state : { ...state, compose };
    });

  const writeDraft = (storyId: string, update: (draft: StoryComposeDraft) => StoryComposeDraft): void =>
    writeCompose((compose) => {
      const current = composeDraftOf(compose, storyId);
      const next = update(current);
      return next === current ? compose : { ...compose, drafts: { ...compose.drafts, [storyId]: next } };
    });

  const hostFor = (storyId: string): DraftHost => ({
    read: () => composeDraftOf(store.get().compose, storyId),
    write: (update) => writeDraft(storyId, update)
  });

  /** A text goes to the history, and the walk of the box that sent it starts
   * over. The other box's walk is left alone. */
  const pushHistory = (storyId: string, text: string, box: "direct" | "retake"): void =>
    writeCompose((compose) => {
      const history = text.trim().length > 0 ? [...compose.history, text] : compose.history;
      const current = composeDraftOf(compose, storyId);
      const walking = box === "direct" ? current.walk : current.retakeWalk;
      const drafts = walking === null
        ? compose.drafts
        : {
          ...compose.drafts,
          [storyId]: box === "direct" ? { ...current, walk: null } : { ...current, retakeWalk: null }
        };
      return { ...compose, history, drafts };
    });

  /** Closes retake mode. A direction the writer changed goes to the history
   * first, so closing or retargeting a retake never throws it away. */
  const archiveRetake = (storyId: string): void => {
    const retake = composeDraftOf(store.get().compose, storyId).retake;
    if (retake === null) return;
    const node = openPart(store.get(), retake.nodeId)?.node;
    const startedWith = retake.rewrite === undefined ? node?.instruction : "";
    if (retake.text.trim().length > 0 && retake.text !== startedWith) pushHistory(storyId, retake.text, "retake");
    writeDraft(storyId, (draft) => ({ ...draft, retake: null, retakeWalk: null }));
  };

  const images = createImageActions(store, writeDraft);

  return {
    ...images,

    setText: (storyId, text) => writeDraft(storyId, (draft) => (
      draft.retake === null
        ? (draft.direct === text ? draft : { ...draft, direct: text })
        : (draft.retake.text === text ? draft : { ...draft, retake: { ...draft.retake, text } })
    )),

    startRetake: (partId) => {
      const target = openPart(store.get(), partId);
      if (target === null) return;
      const { storyId, node } = target;
      // A retake already open for this part keeps what the writer typed; one
      // open for another part is archived before this one replaces it.
      if (composeDraftOf(store.get().compose, storyId).retake?.nodeId !== node.id) archiveRetake(storyId);
      writeDraft(storyId, (draft) => (
        draft.retake?.nodeId === node.id ? draft : { ...draft, retake: { nodeId: node.id, text: node.instruction } }
      ));
      deps.story.focusPart(partId);
      focusComposer();
    },

    startRewrite: (partId, range) => {
      const target = openPart(store.get(), partId);
      if (target === null) return;
      const { storyId, node } = target;
      // The same passage already open keeps what the writer typed; anything
      // else open is archived before this one replaces it.
      const open = composeDraftOf(store.get().compose, storyId).retake;
      const same = open?.nodeId === node.id && open.rewrite?.start === range.start && open.rewrite.end === range.end;
      if (!same) archiveRetake(storyId);
      writeDraft(storyId, (draft) => (same ? draft : { ...draft, retake: { nodeId: node.id, text: "", rewrite: range }, retakeWalk: null }));
      deps.story.focusPart(partId);
      focusComposer();
    },

    cancelRetake: archiveRetake,

    submit: (storyId) => {
      const refusal = submitRefusal(store.get(), storyId);
      if (refusal !== null) {
        pushToast(store, refusal);
        return false;
      }
      const draft = composeDraftOf(store.get().compose, storyId);
      const host = hostFor(storyId);

      if (draft.retake !== null && draft.retake.rewrite !== undefined) {
        const rewrite = draft.retake.rewrite;
        const target = openPart(store.get(), draft.retake.nodeId);
        if (target === null) {
          pushToast(store, "That part is no longer on the line. Draft kept.");
          return false;
        }
        const rewriteRefusal = partActionRefusal(store.get(), target.node.id, "rewrite-selection");
        if (rewriteRefusal !== null) {
          pushToast(store, `${rewriteRefusal} Draft kept.`);
          return false;
        }
        const resolved = resolveRewriteRange(target.story.payload, target.node.id, rewrite.start, rewrite.end, rewrite.expected);
        if ("error" in resolved) {
          pushToast(store, `${resolved.error}. Draft kept.`);
          return false;
        }
        const text = draft.retake.text;
        pushHistory(storyId, text, "retake");
        const handle = createRetakeDraft(host, { nodeId: target.node.id, text, rewrite }, draft.direct);
        writeDraft(storyId, (current) => ({ ...current, retake: null, retakeWalk: null }));
        deps.story.focusPart(target.node.id);
        void deps.generation.rewrite({ partId: target.node.id, ...rewrite, instruction: text, draft: handle });
        return true;
      }

      if (draft.retake !== null) {
        const target = openPart(store.get(), draft.retake.nodeId);
        if (target === null || target.node.role === "summary") {
          pushToast(store, RETAKE_GONE_TOAST);
          return false;
        }
        const retakeRefusal = partActionRefusal(store.get(), target.node.id, "retake");
        if (retakeRefusal !== null) {
          pushToast(store, `${retakeRefusal} Draft kept.`);
          return false;
        }
        const text = draft.retake.text;
        pushHistory(storyId, text, "retake");
        const attached = draft.images;
        const handle = createRetakeDraft(host, { nodeId: target.node.id, text }, draft.direct, attached);
        writeDraft(storyId, (current) => ({ ...current, retake: null, retakeWalk: null, images: [] }));
        // Focus the part being replaced: a landed take moves focus onto
        // itself only when focus still sits where the run started.
        deps.story.focusPart(target.node.id);
        void deps.generation.continue({ instruction: text, retakeOf: target.node.id, draft: handle, images: attached });
        return true;
      }

      const attached = draft.images;
      if (draft.direct.trim().length === 0 && attached.length > 0) {
        // Images go with a new take, and a take has a direction: the default.
        const handle = createDirectDraft(host, "", attached);
        writeDraft(storyId, (current) => ({ ...current, direct: "", images: [] }));
        void deps.generation.continue({ instruction: DEFAULT_INSTRUCTION, draft: handle, images: attached });
        return true;
      }
      const text = draft.direct;
      if (text.trim().length === 0) {
        // An empty box is a plain Continue.
        writeDraft(storyId, (current) => (current.direct === "" ? current : { ...current, direct: "" }));
        void deps.generation.continue();
        return true;
      }
      pushHistory(storyId, text, "direct");
      const handle = createDirectDraft(host, text, attached);
      writeDraft(storyId, (current) => ({ ...current, direct: "", images: [] }));
      void deps.generation.continue({ instruction: text, draft: handle, ...(attached.length === 0 ? {} : { images: attached }) });
      return true;
    },

    historyMove: (storyId, direction) => writeCompose((compose) => {
      const draft = composeDraftOf(compose, storyId);
      const current = draft.retake === null ? draft.walk : draft.retakeWalk;
      const last = compose.history.length;
      const index = current?.index ?? last;
      const next = Math.max(0, Math.min(last, index + direction));
      if (next === index) return compose;
      const saved = current?.draft ?? visibleComposeText(draft);
      const text = next === last ? saved : (compose.history[next] ?? "");
      const walk = next === last ? null : { index: next, draft: saved };
      const nextDraft: StoryComposeDraft = draft.retake === null
        ? { ...draft, direct: text, walk }
        : { ...draft, retake: { ...draft.retake, text }, retakeWalk: walk };
      return { ...compose, drafts: { ...compose.drafts, [storyId]: nextDraft } };
    })
  };
}
