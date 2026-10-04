import { countWords } from "../../../shared/story-text.js";
import { runBusyToast } from "../app/run-lock.js";
import { failureToast, runStoryMutation } from "../app/story-mutation.js";
import type { AppState } from "../app/state.js";
import type { Store } from "../app/store.js";
import { pushToast } from "../app/toasts.js";
import { composeDraftOf, visibleComposeText } from "../compose/state.js";
import type { ComposeActions } from "../compose/actions.js";
import type { FactActions } from "../facts/index.js";
import type { PanelActions } from "../panel/actions.js";
import { openStory } from "../chapters/model.js";
import { NO_CLIPBOARD_TOAST } from "../story/copy.js";
import type { StoryActions } from "../story/actions.js";
import { SWITCHING_TOAST, storyChangeRefusal } from "../story/story-policy.js";
import { effectiveFocusedPartId } from "../story/state.js";
import {
  FROM_ASIDE_INSTRUCTION,
  findCreatedNode,
  indexOfPick,
  initialPick,
  parentOfStop,
  pickOfStop,
  placementStops,
  type PlacementPick
} from "./placement.js";
import type { AsidePlacement, AsideState } from "./state.js";

export const NO_PART_TO_PLACE_TOAST = "This story has no part yet. Write the first part first.";

/** The "use" of an Aside answer: copy it, put it in the composer, put it in the
 * story, or make a Fact of it. */
export interface AsideUseActions {
  copyAnswer(text: string): Promise<void>;
  /** Puts the text at the composer's caret. */
  insertIntoCompose(text: string): void;
  /** Opens the Fact editor with the text filled in. */
  insertAsFact(text: string): void;
  /** Starts the choice of a place ("Insert here") for the text. */
  startPlacement(text: string): void;
  movePlacement(delta: 1 | -1): void;
  pickPlacement(pick: PlacementPick): void;
  /** Creates the take at the picked place. */
  confirmPlacement(): Promise<void>;
  /** Esc: back to Aside, nothing changed. */
  cancelPlacement(): void;
}

const DOCKED_QUERY = "(min-width: 1200px)";

export function createAsideUseActions(
  store: Store<AppState>,
  deps: {
    readonly story: Pick<StoryActions, "adoptPayload">;
    readonly compose: Pick<ComposeActions, "setText">;
    readonly facts: Pick<FactActions, "openNew">;
    readonly panel: Pick<PanelActions, "open" | "close">;
  }
): AsideUseActions {
  const set = (update: (aside: AsideState) => AsideState): void =>
    store.set((state) => {
      const aside = update(state.aside);
      return aside === state.aside ? state : { ...state, aside };
    });
  const setPlacement = (update: (placement: AsidePlacement) => AsidePlacement): void =>
    set((aside) => (aside.placement === null ? aside : { ...aside, placement: update(aside.placement) }));

  return {
    copyAnswer: async (text) => {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        pushToast(store, NO_CLIPBOARD_TOAST);
        return;
      }
      pushToast(store, `Copied answer · ${countWords(text).toLocaleString("en-US")} words`);
    },

    insertIntoCompose: (text) => {
      const state = store.get();
      const open = openStory(state);
      if (open === null) return;
      const field = document.querySelector<HTMLTextAreaElement>(".composer-field");
      const current = visibleComposeText(composeDraftOf(state.compose, open.storyId));
      // The caret is the box's own while the text on screen is the draft; with
      // no box on the page the answer goes at the end.
      const known = field !== null && field.value === current;
      const start = known ? field.selectionStart : current.length;
      const end = known ? field.selectionEnd : current.length;
      deps.compose.setText(open.storyId, `${current.slice(0, start)}${text}${current.slice(end)}`);
      pushToast(store, "Inserted into the composer.");
      if (field !== null) {
        const caret = start + text.length;
        field.focus();
        setTimeout(() => field.setSelectionRange(caret, caret), 0);
      }
    },

    insertAsFact: (text) => deps.facts.openNew({ text }),

    startPlacement: (text) => {
      const state = store.get();
      const open = openStory(state);
      if (open === null) return;
      const refusal = storyChangeRefusal(state, open.storyId)
        ?? (state.story.kind === "loaded" && state.story.switching !== null ? SWITCHING_TOAST : null);
      if (refusal !== null) {
        pushToast(store, refusal);
        return;
      }
      const focused = state.story.kind === "loaded" ? effectiveFocusedPartId(state.story) : null;
      const pick = initialPick(open.payload, state.aside.surface?.anchor?.takeId ?? focused);
      if (pick === null) {
        pushToast(store, NO_PART_TO_PLACE_TOAST);
        return;
      }
      set((aside) => ({ ...aside, placement: { storyId: open.storyId, answer: text, pick, placing: false } }));
      // A drawer would cover the places.
      if (!window.matchMedia(DOCKED_QUERY).matches) deps.panel.close();
    },

    movePlacement: (delta) => {
      const state = store.get();
      const placement = state.aside.placement;
      const open = openStory(state);
      if (placement === null || placement.placing || open === null || open.storyId !== placement.storyId) return;
      const stops = placementStops(open.payload);
      const at = indexOfPick(stops, placement.pick);
      const next = stops[Math.max(0, Math.min(stops.length - 1, at + delta))];
      if (next !== undefined) setPlacement((current) => ({ ...current, pick: pickOfStop(next) }));
    },

    pickPlacement: (pick) => setPlacement((placement) => (placement.placing ? placement : { ...placement, pick })),

    cancelPlacement: () => {
      if (store.get().aside.placement?.placing === true) return;
      set((aside) => (aside.placement === null ? aside : { ...aside, placement: null }));
      deps.panel.open("aside");
    },

    confirmPlacement: async () => {
      const state = store.get();
      const placement = state.aside.placement;
      const open = openStory(state);
      if (placement === null || placement.placing || open === null || open.storyId !== placement.storyId) return;
      // Any Aside run (also one in another story) owns the one run slot.
      const refusal = storyChangeRefusal(state, open.storyId) ?? runBusyToast(state, open.storyId);
      if (refusal !== null) {
        pushToast(store, refusal);
        return;
      }
      const stops = placementStops(open.payload);
      const stop = stops[indexOfPick(stops, placement.pick)];
      if (stop === undefined) return;
      const { storyId, api } = open;
      const parentId = parentOfStop(stop);
      const known = new Set(open.payload.nodes.map((node) => node.id));
      const text = placement.answer;
      // The create is a story change: the story is locked while it runs.
      set((aside) => ({
        ...aside,
        placement: { ...placement, placing: true },
        run: { storyId, storyTitle: open.payload.title, kind: "change", question: "", text: "", phase: "waiting", stopping: false }
      }));
      const outcome = await runStoryMutation(
        api,
        storyId,
        async () => ({ payload: await api.createNode(storyId, { parentId, text, instruction: FROM_ASIDE_INSTRUCTION }) }),
        (reloaded) => (findCreatedNode(reloaded, known, parentId, text) === undefined ? null : {})
      );
      set((aside) => ({ ...aside, run: null }));
      if (outcome.kind !== "saved") {
        // The place stays picked, so the writer can try again.
        setPlacement((current) => ({ ...current, placing: false }));
        if (outcome.kind !== "unresolved" && outcome.payload !== null) deps.story.adoptPayload(storyId, outcome.payload);
        pushToast(store, failureToast(outcome, "Insert into story"));
        return;
      }
      const landed = findCreatedNode(outcome.payload, known, parentId, text);
      const number = landed === undefined ? stop.partNumber : outcome.payload.path.findIndex((node) => node.id === landed.id) + 1;
      deps.story.adoptPayload(storyId, outcome.payload, {
        ...(landed === undefined ? {} : { focus: { kind: "part" as const, partId: landed.id } }),
        announcement: `Placed as Part ${number}.`
      });
      set((aside) => ({ ...aside, placement: null }));
      pushToast(store, `Placed as Part ${number}.`);
      if (!window.matchMedia(DOCKED_QUERY).matches) deps.panel.close();
    }
  };
}
