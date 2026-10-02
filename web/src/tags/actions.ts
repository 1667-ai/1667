import { apiErrorCode } from "../../../client/api-error.js";
import { rememberedLeafId } from "../../../shared/story-model.js";
import type { StoryPayload, TagStatus } from "../../../shared/types.js";
import type { AppState } from "../app/state.js";
import { failureToast, runStoryMutation, type StoryMutationOutcome } from "../app/story-mutation.js";
import type { Store } from "../app/store.js";
import { pushToast } from "../app/toasts.js";
import type { StoryActions } from "../story/actions.js";
import { openPart } from "../story/state.js";
import { storyChangeRefusal } from "../story/story-policy.js";
import { stillLineEnd, tagDraftKey, tagDraftOf, tagOf, type TagDraft, type TagsState } from "./state.js";

export interface TagActionDependencies {
  readonly story: Pick<StoryActions, "adoptPayload">;
}

export interface TagsActions {
  /** `t` and the part menu: opens the popover on the line this part belongs to. */
  openForPart(partId: string): void;
  /** The header chip: opens the popover on the line being read. */
  openForLine(): void;
  close(): void;
  setName(name: string): void;
  setStatus(status: TagStatus): void;
  /** Saves the open popover's draft as the line's tag. */
  save(): Promise<void>;
  /** Removes one line's tag (the popover's Remove, or a row of the list). */
  remove(nodeId: string): Promise<void>;
}

export const NAME_REQUIRED_TOAST = "Name the line first. Draft kept.";
export const LINE_CHANGED_TOAST = "That line changed. Open the tag again.";

type Loaded = { readonly storyId: string; readonly payload: StoryPayload };

function loadedStory(state: AppState): Loaded | null {
  if (state.route.kind !== "story" || state.story.kind !== "loaded") return null;
  return state.story.payload.id === state.route.id ? { storyId: state.route.id, payload: state.story.payload } : null;
}

export function createTagActions(store: Store<AppState>, deps: TagActionDependencies): TagsActions {
  const write = (update: (tags: TagsState) => TagsState): void =>
    store.set((state) => {
      const tags = update(state.tags);
      return tags === state.tags ? state : { ...state, tags };
    });

  const setDraft = (change: (draft: TagDraft) => TagDraft): void => {
    const state = store.get();
    const open = state.tags.open;
    const story = loadedStory(state);
    if (open === null || story === null || story.storyId !== open.storyId) return;
    const next = change(tagDraftOf(state.tags, story.payload, open));
    write((tags) => ({ ...tags, drafts: { ...tags.drafts, [tagDraftKey(open.storyId, open.nodeId)]: next } }));
  };

  const openOn = (nodeId: string, returnTo: "chip" | "part"): void => {
    const story = loadedStory(store.get());
    if (story === null) return;
    write((tags) => ({ ...tags, open: { storyId: story.storyId, nodeId, returnTo } }));
  };

  /** Adopts the reload a failed call left behind, and says what happened. */
  function settleFailure(
    storyId: string,
    outcome: Exclude<StoryMutationOutcome<object>, { kind: "saved" }>,
    what: string,
    kept: string
  ): void {
    if (outcome.kind !== "unresolved" && outcome.payload !== null) deps.story.adoptPayload(storyId, outcome.payload);
    pushToast(store, failureToast(outcome, what, kept));
  }

  async function save(): Promise<void> {
    const state = store.get();
    const open = state.tags.open;
    const story = loadedStory(state);
    if (open === null || story === null || story.storyId !== open.storyId || state.tags.busy) return;
    const { storyId, payload } = story;
    const draft = tagDraftOf(state.tags, payload, open);
    const name = draft.name.trim();
    if (name.length === 0) {
      pushToast(store, NAME_REQUIRED_TOAST);
      return;
    }
    const refusal = storyChangeRefusal(state, storyId);
    if (refusal !== null) {
      pushToast(store, `${refusal} Draft kept.`);
      return;
    }
    if (!stillLineEnd(payload, open.nodeId)) {
      pushToast(store, LINE_CHANGED_TOAST);
      write((tags) => ({ ...tags, open: null }));
      return;
    }
    if (state.connection.kind !== "connected") return;
    const api = state.connection.api;
    const { nodeId } = open;
    write((tags) => ({ ...tags, busy: true }));
    const outcome = await runStoryMutation(
      api,
      storyId,
      async () => ({ payload: await api.putBookmark(storyId, nodeId, name, draft.status) }),
      (reloaded) => (tagOf(reloaded, nodeId)?.name === name && tagOf(reloaded, nodeId)?.status === draft.status ? {} : null)
    );
    write((tags) => ({ ...tags, busy: false }));
    if (outcome.kind !== "saved") {
      settleFailure(storyId, outcome, "Saving the tag", " Draft kept.");
      return;
    }
    const announcement = `Tagged line “${name}”.`;
    if (!deps.story.adoptPayload(storyId, outcome.payload, { announcement })) pushToast(store, announcement);
    write((tags) => {
      const { [tagDraftKey(storyId, nodeId)]: _gone, ...drafts } = tags.drafts;
      const stillThere = tags.open !== null && tags.open.storyId === storyId && tags.open.nodeId === nodeId;
      return { ...tags, drafts, open: stillThere ? null : tags.open };
    });
  }

  async function remove(nodeId: string): Promise<void> {
    const state = store.get();
    const story = loadedStory(state);
    if (story === null || state.tags.busy) return;
    const { storyId } = story;
    const refusal = storyChangeRefusal(state, storyId);
    if (refusal !== null) {
      pushToast(store, refusal);
      return;
    }
    if (state.connection.kind !== "connected") return;
    const api = state.connection.api;
    write((tags) => ({ ...tags, busy: true }));
    const outcome = await runStoryMutation(
      api,
      storyId,
      async () => ({ payload: await api.deleteBookmark(storyId, nodeId) }),
      (reloaded) => (tagOf(reloaded, nodeId) === null ? {} : null)
    );
    write((tags) => ({ ...tags, busy: false }));
    // A tag that is already gone is the outcome the writer asked for.
    let payload: StoryPayload | null = null;
    if (outcome.kind === "saved") payload = outcome.payload;
    else if (outcome.kind === "failed" && outcome.payload !== null && apiErrorCode(outcome.error) === "not_found") {
      payload = outcome.payload;
    }
    if (payload === null) {
      if (outcome.kind !== "saved") settleFailure(storyId, outcome, "Removing the tag", "");
      return;
    }
    const announcement = "Tag removed.";
    if (!deps.story.adoptPayload(storyId, payload, { announcement })) pushToast(store, announcement);
    write((tags) => {
      const { [tagDraftKey(storyId, nodeId)]: _gone, ...drafts } = tags.drafts;
      const stillThere = tags.open !== null && tags.open.storyId === storyId && tags.open.nodeId === nodeId;
      return { ...tags, drafts, open: stillThere ? null : tags.open };
    });
  }

  return {
    openForPart: (partId) => {
      const target = openPart(store.get(), partId);
      if (target === null) return;
      openOn(rememberedLeafId(target.story.payload, partId), "part");
    },
    openForLine: () => {
      const leaf = loadedStory(store.get())?.payload.path.at(-1);
      if (leaf !== undefined) openOn(leaf.id, "chip");
    },
    close: () => write((tags) => (tags.open === null ? tags : { ...tags, open: null })),
    setName: (name) => setDraft((draft) => ({ ...draft, name })),
    setStatus: (status) => setDraft((draft) => ({ ...draft, status })),
    save,
    remove
  };
}
