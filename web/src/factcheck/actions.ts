import type { FactConsistencyRun, FactConsistencyScope } from "../../../shared/fact-consistency-contract.js";
import type { StoryPayload } from "../../../shared/types.js";
import { retryWhenBusy } from "../app/busy-retry.js";
import { runBusyToast } from "../app/run-lock.js";
import type { AppState } from "../app/state.js";
import { failureToast, runStoryMutation } from "../app/story-mutation.js";
import type { Store } from "../app/store.js";
import { errorMessage, pushToast } from "../app/toasts.js";
import type { PanelActions } from "../panel/actions.js";
import { NOT_CONNECTED_TOAST } from "../story/story-policy.js";
import type { StoryActions } from "../story/actions.js";
import { effectiveFocusedPartId } from "../story/state.js";
import type { FactCheckState } from "./state.js";
import type { FindingRow } from "./model.js";

export interface FactCheckActionDependencies {
  readonly story: Pick<StoryActions, "adoptPayload" | "focusPart">;
  readonly panel: Pick<PanelActions, "open" | "close">;
}

export interface FactCheckActions {
  /** The palette's "check chapter against Facts" and "check story line against Facts". */
  start(scope: FactConsistencyScope): Promise<void>;
  /** Cancel on the confirmation: nothing runs. */
  cancel(): void;
  /** Check on the confirmation. */
  confirm(): Promise<void>;
  /** The palette's "show Fact findings": loads the last run and opens the Findings view. */
  show(): Promise<void>;
  /** A finding was chosen: focuses its part when it is on the line being read. */
  select(row: FindingRow): void;
}

export const FACT_CHECK_UNAVAILABLE_TOAST = "Fact consistency is not available in this backend.";
export const FACT_CHECK_NO_PART_TOAST = "Select a story part before checking Facts.";
export const FACT_CHECK_NOTHING_TOAST = "Nothing to check.";
export const FACT_FINDINGS_NONE_TOAST = "Fact findings are not available.";
export const FINDING_STALE_TOAST = "This finding is out of date. The part has changed.";
export const FINDING_OFF_LINE_TOAST = "This finding is on another story line. Switch to that line in the map.";

type Loaded = { readonly storyId: string; readonly payload: StoryPayload; readonly focusedPartId: string | null };

function loadedStory(state: AppState): Loaded | null {
  if (state.route.kind !== "story" || state.route.map === true || state.story.kind !== "loaded") return null;
  if (state.story.payload.id !== state.route.id) return null;
  return { storyId: state.route.id, payload: state.story.payload, focusedPartId: effectiveFocusedPartId(state.story) };
}

export function createFactCheckActions(store: Store<AppState>, deps: FactCheckActionDependencies): FactCheckActions {
  let serial = 0;

  const write = (update: (check: FactCheckState) => FactCheckState): void =>
    store.set((state) => {
      const factCheck = update(state.factCheck);
      return factCheck === state.factCheck ? state : { ...state, factCheck };
    });

  /** After any failure the story is reloaded, because a failed call can still move its version. */
  async function reload(storyId: string): Promise<void> {
    const state = store.get();
    if (state.connection.kind !== "connected") return;
    const payload = await state.connection.api.loadStory(storyId).catch(() => null);
    if (payload !== null) deps.story.adoptPayload(storyId, payload);
  }

  function openFindings(storyId: string, run: FactConsistencyRun): void {
    write((check) => ({ ...check, findings: { storyId, run } }));
    const route = store.get().route;
    if (route.kind === "story" && route.id === storyId && route.map !== true) deps.panel.open("findings");
  }

  async function start(scope: FactConsistencyScope): Promise<void> {
    const state = store.get();
    const story = loadedStory(state);
    if (story === null) return;
    if (state.connection.kind !== "connected") {
      pushToast(store, NOT_CONNECTED_TOAST);
      return;
    }
    const api = state.connection.api;
    if (api.planFactConsistency === undefined || api.checkFactConsistency === undefined) {
      pushToast(store, FACT_CHECK_UNAVAILABLE_TOAST);
      return;
    }
    if (story.focusedPartId === null) {
      pushToast(store, FACT_CHECK_NO_PART_TOAST);
      return;
    }
    const busy = runBusyToast(state, story.storyId);
    if (busy !== null) {
      pushToast(store, busy);
      return;
    }
    const { storyId, focusedPartId } = story;
    serial += 1;
    const mine = serial;
    write((check) => ({ ...check, confirm: { storyId, focusedPartId, scope, plan: null, serial: mine } }));
    try {
      const plan = await retryWhenBusy(() => api.planFactConsistency!({ storyId, focusedPartId, scope }));
      write((check) => (check.confirm?.serial === mine ? { ...check, confirm: { ...check.confirm, plan } } : check));
    } catch (error) {
      if (store.get().factCheck.confirm?.serial !== mine) return;
      write((check) => ({ ...check, confirm: null }));
      await reload(storyId);
      pushToast(store, `Planning the Fact check failed: ${errorMessage(error)}`);
    }
  }

  async function confirm(): Promise<void> {
    const state = store.get();
    const pending = state.factCheck.confirm;
    if (pending === null || pending.plan === null || state.factCheck.running !== null) return;
    if (pending.plan.partCount === 0) {
      pushToast(store, FACT_CHECK_NOTHING_TOAST);
      return;
    }
    if (state.connection.kind !== "connected") {
      pushToast(store, NOT_CONNECTED_TOAST);
      return;
    }
    // A run that started after the plan was made still holds the story: say
    // so and keep the confirmation for another try.
    const busy = runBusyToast(state, pending.storyId);
    if (busy !== null) {
      pushToast(store, busy);
      return;
    }
    const api = state.connection.api;
    const { storyId, focusedPartId, scope, plan } = pending;
    const storyTitle = state.story.kind === "loaded" && state.story.payload.id === storyId ? state.story.payload.title : "this story";
    write((check) => ({ ...check, confirm: null, running: { storyId, storyTitle } }));
    // A lost answer is not checked against a reload: the run is stored by the
    // backend, so "show Fact findings" finds it if it did finish.
    const outcome = await runStoryMutation<{ readonly run: FactConsistencyRun }>(
      api,
      storyId,
      async () => {
        const result = await api.checkFactConsistency!({ storyId, focusedPartId, scope, planToken: plan.planToken });
        return { payload: result.payload, run: result.run };
      },
      () => null
    );
    write((check) => ({ ...check, running: null }));
    if (outcome.kind !== "saved") {
      if (outcome.kind !== "unresolved" && outcome.payload !== null) deps.story.adoptPayload(storyId, outcome.payload);
      pushToast(store, failureToast(outcome, "Checking Facts"));
      return;
    }
    const { run } = outcome.value;
    const found = run.parts.reduce((total, part) => total + part.findings.length, 0);
    const message = found === 0 ? "No contradictions found." : `Fact check found ${found} ${found === 1 ? "contradiction" : "contradictions"}.`;
    deps.story.adoptPayload(storyId, outcome.payload, { announcement: message });
    pushToast(store, message);
    openFindings(storyId, run);
  }

  async function show(): Promise<void> {
    const state = store.get();
    const story = loadedStory(state);
    if (story === null) return;
    if (state.connection.kind !== "connected") {
      pushToast(store, NOT_CONNECTED_TOAST);
      return;
    }
    const api = state.connection.api;
    if (api.getFactConsistencyRun === undefined) {
      pushToast(store, FACT_CHECK_UNAVAILABLE_TOAST);
      return;
    }
    const { storyId } = story;
    try {
      const run = await retryWhenBusy(() => api.getFactConsistencyRun!(storyId));
      if (run === null) {
        pushToast(store, FACT_FINDINGS_NONE_TOAST);
        return;
      }
      openFindings(storyId, run);
    } catch (error) {
      await reload(storyId);
      pushToast(store, `Loading the Fact findings failed: ${errorMessage(error)}`);
    }
  }

  return {
    start,
    cancel: () => write((check) => (check.confirm === null ? check : { ...check, confirm: null })),
    confirm,
    show,
    select: (row) => {
      if (row.status === "stale") {
        pushToast(store, FINDING_STALE_TOAST);
        return;
      }
      if (row.status === "off-line") {
        pushToast(store, FINDING_OFF_LINE_TOAST);
        return;
      }
      deps.story.focusPart(row.partId);
      // A drawer would cover the part and keep the keys.
      if (!window.matchMedia("(min-width: 1200px)").matches) deps.panel.close();
    }
  };
}
