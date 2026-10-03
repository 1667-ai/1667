import { apiErrorCode } from "../../../client/api-error.js";
import { MAX_STORY_FACTS_BUDGET_TOKENS } from "../../../shared/fact-budget.js";
import { parseBudgetText } from "../../../shared/fact-draft-text.js";
import { canonicalFactStates } from "../../../shared/fact-state.js";
import type { StoryPayload } from "../../../shared/types.js";
import type { AppState } from "../app/state.js";
import type { Store } from "../app/store.js";
import { failureToast, runStoryMutation, type StoryMutationOutcome } from "../app/story-mutation.js";
import { pushToast } from "../app/toasts.js";
import type { PanelActions } from "../panel/actions.js";
import type { StoryActions } from "../story/actions.js";
import { storyChangeRefusal } from "../story/story-policy.js";
import { loadedStory, type FactEditorActions } from "./actions.js";
import { factEditorDirty, STATES_UNAVAILABLE_TOAST, type FactsFilter, type FactsState } from "./state.js";

export interface FactListActions {
  setFilter(change: Partial<FactsFilter>): void;
  deleteFact(factId: string): Promise<boolean>;
  /** Moves a fact one place up (`-1`) or down (`1`) among the story's facts. */
  move(factId: string, direction: -1 | 1): Promise<void>;
  /** Sets the story's facts budget from the typed text; empty clears it.
   * Returns whether it was saved. */
  setBudget(text: string): Promise<boolean>;
  deleteState(factId: string, stateId: string): Promise<void>;
  /** The part menu's "New fact state" and "End fact here": the writer picks
   * the fact in the panel next. */
  startPick(action: "new-state" | "end", partId: string): void;
  cancelPick(): void;
  /** The ◆ mark: opens Facts filtered to the facts with a state at this part. */
  showAnchored(partId: string): void;
  /** The pick: finishes the action on this fact. */
  pickFact(factId: string): Promise<void>;
}

export const CLEAR_FILTER_TO_REORDER_TOAST = "Clear the filters to reorder facts.";

export function createFactListActions(
  store: Store<AppState>,
  deps: {
    readonly story: Pick<StoryActions, "adoptPayload">;
    readonly editor: FactEditorActions;
    readonly panel: Pick<PanelActions, "open">;
  }
): FactListActions {
  const writeFacts = (change: (facts: FactsState) => FactsState): void =>
    store.set((state) => {
      const facts = change(state.facts);
      return facts === state.facts ? state : { ...state, facts };
    });

  /** One story change: refusal, busy flag, the shared outcome handling. A
   * `saved` payload is adopted; a failure reloads, adopts the reload, and says
   * what happened. Returns the payload that landed, or `null`. */
  async function change(
    what: string,
    announcement: string,
    run: (api: NonNullable<ReturnType<typeof connectedApi>>, storyId: string) => Promise<StoryMutationOutcome<object>>,
    options: { readonly alreadyDone?: (error: unknown) => boolean } = {}
  ): Promise<StoryPayload | null> {
    const state = store.get();
    const loaded = loadedStory(state);
    const api = connectedApi(state);
    if (loaded === null || state.facts.busy) return null;
    const refusal = storyChangeRefusal(state, loaded.storyId);
    if (refusal !== null || api === null) {
      pushToast(store, refusal ?? "Not connected.");
      return null;
    }
    writeFacts((facts) => ({ ...facts, busy: true }));
    const outcome = await run(api, loaded.storyId);
    writeFacts((facts) => ({ ...facts, busy: false }));
    let payload: StoryPayload | null = null;
    if (outcome.kind === "saved") payload = outcome.payload;
    else if (outcome.kind === "failed" && outcome.payload !== null && options.alreadyDone?.(outcome.error) === true) {
      payload = outcome.payload;
    }
    if (payload === null) {
      if (outcome.kind !== "saved") {
        if (outcome.kind !== "unresolved" && outcome.payload !== null) deps.story.adoptPayload(loaded.storyId, outcome.payload);
        pushToast(store, failureToast(outcome, what));
      }
      return null;
    }
    if (!deps.story.adoptPayload(loaded.storyId, payload, { announcement })) pushToast(store, announcement);
    return payload;
  }

  return {
    setFilter: (partial) => writeFacts((facts) => ({ ...facts, filter: { ...facts.filter, ...partial } })),

    deleteFact: async (factId) => {
      const payload = await change(
        "Deleting the fact",
        "Fact deleted.",
        (api, storyId) => runStoryMutation(
          api, storyId,
          async () => ({ payload: await api.deleteFact(storyId, factId) }),
          (reloaded) => (reloaded.facts.some((fact) => fact.id === factId) ? null : {})
        ),
        { alreadyDone: (error) => apiErrorCode(error) === "not_found" }
      );
      if (payload === null) return false;
      writeFacts((facts) => (facts.editor?.factId === factId ? { ...facts, editor: null } : facts));
      return true;
    },

    move: async (factId, direction) => {
      const state = store.get();
      const { scope, tag, query } = state.facts.filter;
      if (scope !== "everywhere" || tag !== null || query.length > 0) {
        pushToast(store, CLEAR_FILTER_TO_REORDER_TOAST);
        return;
      }
      const facts = state.story.kind === "loaded" ? state.story.payload.facts : [];
      const from = facts.findIndex((fact) => fact.id === factId);
      const to = from + direction;
      if (from < 0 || to < 0 || to >= facts.length) return;
      await change(
        "Moving the fact",
        "Fact moved.",
        (api, storyId) => runStoryMutation(
          api, storyId,
          async () => ({ payload: await api.reorderFact(storyId, factId, to) }),
          (reloaded) => (reloaded.facts[to]?.id === factId ? {} : null)
        )
      );
    },

    setBudget: async (text) => {
      const parsed = parseBudgetText(text, MAX_STORY_FACTS_BUDGET_TOKENS, "Facts budget");
      if (!parsed.ok) {
        pushToast(store, parsed.toast);
        return false;
      }
      const value = parsed.budgetTokens;
      const payload = await change(
        "Saving the facts budget",
        value === undefined ? "Facts budget cleared." : `Facts budget set to ${value.toLocaleString()} tokens.`,
        (api, storyId) => runStoryMutation(
          api, storyId,
          async () => ({ payload: await api.setFactsBudget(storyId, value ?? null) }),
          (reloaded) => (reloaded.factsBudgetTokens === value ? {} : null)
        )
      );
      return payload !== null;
    },

    deleteState: async (factId, stateId) => {
      const api = connectedApi(store.get());
      if (api === null || api.deleteFactState === undefined) {
        pushToast(store, STATES_UNAVAILABLE_TOAST);
        return;
      }
      const editor = store.get().facts.editor;
      if (editor !== null && editor.factId === factId && editor.body.kind === "state" && editor.body.stateId === stateId) {
        // Deleting the state under the editor drops its draft: ask first.
        if (factEditorDirty(editor)) {
          pushToast(store, "Save or cancel this fact before deleting its state.");
          return;
        }
      }
      const payload = await change(
        "Deleting the state",
        "Fact state deleted.",
        (client, storyId) => runStoryMutation(
          client, storyId,
          async () => ({ payload: await client.deleteFactState!(storyId, factId, stateId) }),
          (reloaded) => {
            const fact = reloaded.facts.find((candidate) => candidate.id === factId);
            return fact === undefined || !canonicalFactStates(fact).some((state) => state.id === stateId) ? {} : null;
          }
        ),
        { alreadyDone: (error) => apiErrorCode(error) === "not_found" }
      );
      if (payload === null) return;
      const live = store.get().facts.editor;
      if (live !== null && live.factId === factId && live.body.kind === "state" && live.body.stateId === stateId) {
        deps.editor.discard();
        if (payload.facts.some((fact) => fact.id === factId)) deps.editor.open(factId);
      }
    },

    startPick: (action, partId) => {
      const loaded = loadedStory(store.get());
      if (loaded === null) return;
      writeFacts((facts) => ({ ...facts, pick: { storyId: loaded.storyId, action, partId } }));
    },

    showAnchored: (partId) => {
      writeFacts((facts) => ({ ...facts, filter: { scope: "everywhere", tag: null, query: "", anchorPartId: partId } }));
      deps.panel.open("facts");
    },

    cancelPick: () => writeFacts((facts) => (facts.pick === null ? facts : { ...facts, pick: null })),

    pickFact: async (factId) => {
      const pick = store.get().facts.pick;
      if (pick === null) return;
      writeFacts((facts) => ({ ...facts, pick: null }));
      if (pick.action === "new-state") {
        deps.editor.openNewState(factId, pick.partId, false);
        return;
      }
      const api = connectedApi(store.get());
      if (api?.createFactState === undefined) {
        pushToast(store, STATES_UNAVAILABLE_TOAST);
        return;
      }
      await change(
        "Ending the fact",
        "Fact ends here.",
        (client, storyId) => runStoryMutation(
          client, storyId,
          async () => ({ payload: await client.createFactState!(storyId, factId, { ends: true, anchorPartId: pick.partId }) }),
          (reloaded) => {
            const fact = reloaded.facts.find((candidate) => candidate.id === factId);
            return fact !== undefined && canonicalFactStates(fact).some((state) => "ends" in state && state.anchorPartId === pick.partId) ? {} : null;
          }
        )
      );
    }
  };
}

function connectedApi(state: AppState) {
  return state.connection.kind === "connected" ? state.connection.api : null;
}
