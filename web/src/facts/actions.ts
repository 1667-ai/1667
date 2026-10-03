import type { StoryApi } from "../../../client/api.js";
import { factDraftOf } from "../../../shared/fact-draft.js";
import { canonicalFactStates } from "../../../shared/fact-state.js";
import type { StoryFact, StoryPayload } from "../../../shared/types.js";
import type { AppState } from "../app/state.js";
import type { Store } from "../app/store.js";
import { failureToast, type StoryMutationOutcome } from "../app/story-mutation.js";
import { pushToast } from "../app/toasts.js";
import type { PanelActions } from "../panel/actions.js";
import { STORY_RELOADED_TOAST, type StoryActions } from "../story/actions.js";
import { storyChangeRefusal } from "../story/story-policy.js";
import {
  changedFields,
  changedMetadata,
  changedPatch,
  createInputOf,
  formOfDraft,
  metadataChanged,
  parseForm,
  type FactForm,
  type FactFormField
} from "./form.js";
import { editorOnFact, editorOnNewFact, editorOnNewState, editorOnState, formOfFactState } from "./open.js";
import { createdFact, runFactSave, type FactSaveRequest, type FactSaveValue } from "./save.js";
import { factEditorDirty, STATES_UNAVAILABLE_TOAST, type FactEditor, type FactsState } from "./state.js";

export interface FactEditorActionDependencies {
  readonly story: Pick<StoryActions, "adoptPayload">;
  readonly panel: Pick<PanelActions, "open">;
}

export interface FactEditorActions {
  /** Opens the editor on a fact (the one in effect, for a fact with states). */
  open(factId: string): void;
  /** `n`, and the part menu: a new fact, optionally anchored to a part
   * ("Fact from here") or started from selected text. */
  openNew(options?: { readonly text?: string; readonly anchorPartId?: string | null }): void;
  /** A new state on a fact, at a part or story-wide (`null`). */
  openNewState(factId: string, anchorPartId: string | null, ends: boolean): void;
  /** Moves the editor to another state of its fact. */
  openState(stateId: string): void;
  setField(field: FactFormField, value: string): void;
  save(): Promise<void>;
  /** Puts every field back to what the editor opened on. */
  revert(): void;
  /** Escape and Cancel: a clean editor closes; a changed one asks for a
   * second press first. */
  requestClose(): void;
  discard(): void;
}

export const FACT_EDITOR_OPEN_TOAST = "Save or cancel the open fact first.";
export const FACT_CHANGED_TOAST = "This fact changed in another window. Save again to overwrite.";
export const FACT_GONE_TOAST = "This fact no longer exists. Copy your text before closing.";
export const FACT_UNRESOLVED_TOAST =
  "Could not check whether your last save went through. Save again to check; nothing is written twice. Draft kept.";
export const FACT_EARLIER_LANDED_TOAST = "Your earlier save did go through. Your newer changes are still in the editor.";

type Loaded = { readonly storyId: string; readonly payload: StoryPayload };

export function loadedStory(state: AppState): Loaded | null {
  if (state.route.kind !== "story" || state.story.kind !== "loaded") return null;
  return state.story.payload.id === state.route.id ? { storyId: state.route.id, payload: state.story.payload } : null;
}

/** The form a stored fact (and the editor's state) would open with. */
function reloadedFormOf(editor: FactEditor, fact: StoryFact): FactForm {
  return editor.body.kind === "state"
    ? formOfFactState(fact, canonicalFactStates(fact).find((state) => state.id === (editor.body as { stateId: string }).stateId) ?? null)
    : formOfDraft(factDraftOf(fact));
}

/** True when the stored fact differs from what the editor opened on: the story
 * moved on (another window, or a reload while the draft stayed open). The
 * baseline is read the way a reload formats it, and a new state's text is not
 * compared (it starts from the text in effect, not from a stored one). */
function movedSinceOpened(editor: FactEditor, fact: StoryFact): boolean {
  const parsed = parseForm(editor.base, false);
  const base = parsed.ok ? formOfDraft(parsed.draft) : editor.base;
  const stored = reloadedFormOf(editor, fact);
  return changedFields(base, stored).some((field) => field !== "text" || editor.body.kind !== "new-state");
}

/** After a conflict: the writer's changed fields stay; every other field takes
 * the reloaded value, and both baselines become the reloaded fact. */
function mergeAfterConflict(editor: FactEditor, fact: StoryFact): FactEditor {
  const reloaded = reloadedFormOf(editor, fact);
  const changed = new Set(changedFields(editor.base, editor.form));
  const form = Object.fromEntries(
    (Object.keys(reloaded) as FactFormField[]).map((field) => [field, changed.has(field) ? editor.form[field] : reloaded[field]])
  ) as unknown as FactForm;
  const body = editor.body.kind === "state" ? { ...editor.body, baseText: reloaded.text } : editor.body;
  return { ...editor, base: reloaded, form, body, saving: false, overwriteArmed: true };
}

export function createFactEditorActions(store: Store<AppState>, deps: FactEditorActionDependencies): FactEditorActions {
  /** Raised for each opened editor, so a late answer never touches a newer one. */
  let opened = 0;

  const writeFacts = (change: (facts: FactsState) => FactsState): void =>
    store.set((state) => {
      const facts = change(state.facts);
      return facts === state.facts ? state : { ...state, facts };
    });
  const update = (change: (editor: FactEditor) => FactEditor): void =>
    writeFacts((facts) => {
      if (facts.editor === null) return facts;
      const next = change(facts.editor);
      return next === facts.editor ? facts : { ...facts, editor: next };
    });
  const close = (): void => writeFacts((facts) => (facts.editor === null ? facts : { ...facts, editor: null }));

  /** The one way an editor opens: a changed editor is never replaced. */
  function openEditor(make: (loaded: Loaded) => FactEditor | null, same?: (editor: FactEditor) => boolean): void {
    const state = store.get();
    const loaded = loadedStory(state);
    if (loaded === null) return;
    const current = state.facts.editor;
    if (current !== null && current.storyId === loaded.storyId && same?.(current) === true) return;
    if (current !== null && factEditorDirty(current)) {
      pushToast(store, FACT_EDITOR_OPEN_TOAST);
      return;
    }
    const editor = make(loaded);
    if (editor === null) return;
    opened += 1;
    deps.panel.open("facts");
    writeFacts((facts) => ({ ...facts, editor, pick: null }));
  }

  function factOf(loaded: Loaded, factId: string): StoryFact | null {
    return loaded.payload.facts.find((fact) => fact.id === factId) ?? null;
  }

  /** What one Save sends, or why it sends nothing. */
  type Built =
    | { readonly kind: "request"; readonly request: FactSaveRequest; readonly announcement: string; readonly form: FactForm }
    | { readonly kind: "unchanged" }
    | { readonly kind: "refused"; readonly toast: string };

  function build(editor: FactEditor, api: StoryApi, payload: StoryPayload): Built {
    const body = editor.body;
    const ends = body.kind !== "fact" && body.ends;
    const parsed = parseForm(editor.form, !ends);
    if (!parsed.ok) return { kind: "refused", toast: parsed.toast };
    const draft = parsed.draft;
    const changed = changedFields(editor.base, editor.form);
    const { storyId, form } = editor;
    if (editor.factId === null) {
      return {
        kind: "request", form, announcement: "Fact created.",
        request: {
          kind: "create", storyId, input: createInputOf(draft, editor.newAnchorPartId),
          knownFactIds: new Set(payload.facts.map((fact) => fact.id))
        }
      };
    }
    const factId = editor.factId;
    // The editor shows submitted values the way a reload formats them.
    const landed = (fields: readonly FactFormField[]) => (fact: StoryFact): boolean => {
      const shown = formOfDraft(factDraftOf(fact));
      const submitted = formOfDraft(draft);
      return fields.every((field) => field === "text" || shown[field] === submitted[field]);
    };
    if (body.kind === "fact") {
      if (changed.length === 0) return { kind: "unchanged" };
      const textLanded = (fact: StoryFact): boolean => landed(changed)(fact) && (!changed.includes("text") || factDraftOf(fact).text === draft.text);
      return {
        kind: "request", form, announcement: "Fact saved.",
        request: { kind: "patch", storyId, factId, patch: changedPatch(draft, changed), landed: textLanded }
      };
    }
    if (api.createFactState === undefined || api.patchFactState === undefined) {
      return { kind: "refused", toast: STATES_UNAVAILABLE_TOAST };
    }
    const metadata = changedMetadata(draft, changed);
    if (body.kind === "new-state") {
      const known = new Set(canonicalFactStates(payload.facts.find((fact) => fact.id === factId) ?? { states: [] } as never).map((state) => state.id));
      return {
        kind: "request", form, announcement: body.ends ? "Fact end saved." : "Fact state saved.",
        request: {
          kind: "state-create", storyId, factId, knownStateIds: known,
          body: {
            ...(body.ends ? { ends: true as const } : { text: draft.text }),
            anchorPartId: body.anchorPartId,
            ...(metadata === undefined ? {} : { metadata })
          }
        }
      };
    }
    const bodyChanged = !body.ends && editor.form.text !== body.baseText;
    if (!bodyChanged && !metadataChanged(changed)) return { kind: "unchanged" };
    const stateLanded = (fact: StoryFact): boolean => {
      const state = canonicalFactStates(fact).find((candidate) => candidate.id === body.stateId);
      const text = state === undefined || "ends" in state ? null : state.text;
      return state !== undefined && landed(changed)(fact) && (!bodyChanged || text === draft.text);
    };
    if (!bodyChanged) {
      // Only fact metadata changed: the ordinary PATCH carries it.
      return {
        kind: "request", form, announcement: "Fact saved.",
        request: { kind: "patch", storyId, factId, patch: changedPatch(draft, changed), landed: landed(changed) }
      };
    }
    return {
      kind: "request", form, announcement: "Fact state saved.",
      request: {
        kind: "state-patch", storyId, factId, stateId: body.stateId, landed: stateLanded,
        body: { text: draft.text, ...(metadata === undefined ? {} : { metadata }) }
      }
    };
  }

  /** The editor after a save landed: what was sent is the new baseline, and
   * anything typed since stays as an unsaved change. */
  function afterSaved(editor: FactEditor, sent: FactForm, value: FactSaveValue): FactEditor {
    const body = editor.body.kind === "new-state"
      ? (value.stateId === null
        ? editor.body
        : { kind: "state" as const, stateId: value.stateId, anchorPartId: editor.body.anchorPartId, ends: editor.body.ends, baseText: sent.text })
      : editor.body.kind === "state" ? { ...editor.body, baseText: sent.text } : editor.body;
    return { ...editor, factId: value.factId ?? editor.factId, base: sent, body, saving: false, overwriteArmed: false, pending: null, discardArmed: false };
  }

  function settle(
    editor: FactEditor,
    token: number,
    built: Extract<Built, { kind: "request" }>,
    outcome: StoryMutationOutcome<FactSaveValue>
  ): void {
    const stillOpen = opened === token && store.get().facts.editor !== null;
    if (outcome.kind === "saved") {
      if (!deps.story.adoptPayload(editor.storyId, outcome.payload, { announcement: built.announcement })) {
        pushToast(store, built.announcement);
      }
      if (!stillOpen) return;
      const live = store.get().facts.editor!;
      if (outcome.reconciled) pushToast(store, "Saved. The answer was lost, and the reload showed it.");
      const unchanged = Object.keys(live.form).every((key) => live.form[key as FactFormField] === built.form[key as FactFormField]);
      if (unchanged) close();
      else {
        update((current) => afterSaved(current, built.form, outcome.value));
        pushToast(store, "Saved. Your newer edits are kept.");
      }
      return;
    }
    if (outcome.kind !== "unresolved" && outcome.payload !== null) deps.story.adoptPayload(editor.storyId, outcome.payload);
    if (!stillOpen) return;
    if (outcome.kind === "conflict") {
      const reloaded = outcome.payload?.facts.find((fact) => fact.id === editor.factId) ?? null;
      if (editor.factId !== null && outcome.payload !== null && reloaded === null) {
        update((current) => ({ ...current, saving: false }));
        pushToast(store, FACT_GONE_TOAST);
        return;
      }
      if (reloaded === null) {
        update((current) => ({ ...current, saving: false }));
        pushToast(store, `${STORY_RELOADED_TOAST} Draft kept.`);
        return;
      }
      update((current) => mergeAfterConflict(current, reloaded));
      pushToast(store, FACT_CHANGED_TOAST);
      return;
    }
    const sent = built.request;
    if (outcome.kind === "unresolved" && sent.kind === "create") {
      update((current) => ({
        ...current,
        saving: false,
        pending: { input: sent.input, knownFactIds: [...sent.knownFactIds], form: built.form }
      }));
      pushToast(store, FACT_UNRESOLVED_TOAST);
      return;
    }
    update((current) => ({ ...current, saving: false }));
    pushToast(store, failureToast(outcome, "Saving the fact", " Draft kept."));
  }

  async function save(): Promise<void> {
    const state = store.get();
    const editor = state.facts.editor;
    const loaded = loadedStory(state);
    if (editor === null || editor.saving || loaded === null || loaded.storyId !== editor.storyId) return;
    if (state.connection.kind !== "connected") {
      pushToast(store, "Not connected. Draft kept.");
      return;
    }
    const api = state.connection.api;
    const built = build(editor, api, loaded.payload);
    if (built.kind === "unchanged") {
      close();
      return;
    }
    if (built.kind === "refused") {
      pushToast(store, built.toast);
      return;
    }
    const refusal = storyChangeRefusal(state, editor.storyId);
    if (refusal !== null) {
      pushToast(store, `${refusal} Draft kept.`);
      return;
    }
    // A reload may have moved the story on while the draft stayed open: take
    // the conflict path now, before a save overwrites the newer text.
    const stored = editor.factId === null ? undefined : loaded.payload.facts.find((candidate) => candidate.id === editor.factId);
    if (stored !== undefined && editor.pending === null && movedSinceOpened(editor, stored)) {
      update((current) => mergeAfterConflict(current, stored));
      pushToast(store, FACT_CHANGED_TOAST);
      return;
    }
    const token = opened;
    update((current) => ({ ...current, saving: true, discardArmed: false }));
    if (editor.pending !== null) {
      // An earlier create may have committed. Look before sending anything.
      const reloaded = await api.loadStory(editor.storyId).catch(() => null);
      if (opened !== token || store.get().facts.editor === null) return;
      if (reloaded === null) {
        update((current) => ({ ...current, saving: false }));
        pushToast(store, FACT_UNRESOLVED_TOAST);
        return;
      }
      deps.story.adoptPayload(editor.storyId, reloaded);
      const found = createdFact(reloaded, editor.pending.input, new Set(editor.pending.knownFactIds));
      if (found !== null) {
        const sent = editor.pending.form;
        update((current) => afterSaved({ ...current, pending: null }, sent, { factId: found.id, stateId: null }));
        pushToast(store, FACT_EARLIER_LANDED_TOAST);
        const live = store.get().facts.editor;
        if (live !== null && !factEditorDirty(live)) close();
        return;
      }
      update((current) => ({ ...current, pending: null }));
      // The earlier create left nothing: build again against the reload.
      const again = build({ ...editor, pending: null }, api, reloaded);
      if (again.kind !== "request") {
        update((current) => ({ ...current, saving: false }));
        return;
      }
      settle(editor, token, again, await runFactSave(api, again.request));
      return;
    }
    settle(editor, token, built, await runFactSave(api, built.request));
  }

  return {
    open: (factId) => openEditor(
      (loaded) => {
        const fact = factOf(loaded, factId);
        return fact === null ? null : editorOnFact(loaded.storyId, fact, loaded.payload);
      },
      (editor) => editor.factId === factId
    ),

    openNew: (options = {}) => openEditor((loaded) => editorOnNewFact(loaded.storyId, options)),

    openNewState: (factId, anchorPartId, ends) => openEditor((loaded) => {
      const fact = factOf(loaded, factId);
      if (fact === null) return null;
      const connection = store.get().connection;
      if (connection.kind === "connected" && connection.api.createFactState === undefined) {
        pushToast(store, STATES_UNAVAILABLE_TOAST);
        return null;
      }
      return editorOnNewState(loaded.storyId, fact, loaded.payload, anchorPartId, ends);
    }),

    openState: (stateId) => {
      const state = store.get();
      const loaded = loadedStory(state);
      const current = state.facts.editor;
      if (loaded === null || current === null || current.factId === null) return;
      if (current.body.kind === "state" && current.body.stateId === stateId) return;
      if (factEditorDirty(current)) {
        pushToast(store, FACT_EDITOR_OPEN_TOAST);
        return;
      }
      const fact = factOf(loaded, current.factId);
      const target = fact === null ? undefined : canonicalFactStates(fact).find((candidate) => candidate.id === stateId);
      if (fact === null || target === undefined) return;
      opened += 1;
      writeFacts((facts) => ({ ...facts, editor: editorOnState(loaded.storyId, fact, target) }));
    },

    setField: (field, value) => update((editor) => (
      editor.form[field] === value && !editor.discardArmed
        ? editor
        : { ...editor, form: { ...editor.form, [field]: value }, discardArmed: false }
    )),

    save,

    revert: () => update((editor) => (
      editor.saving ? editor : { ...editor, form: editor.base, overwriteArmed: false, discardArmed: false }
    )),

    requestClose: () => {
      const editor = store.get().facts.editor;
      if (editor === null || editor.saving) return;
      if (!factEditorDirty(editor) || editor.discardArmed) {
        close();
        return;
      }
      update((current) => ({ ...current, discardArmed: true }));
    },

    discard: () => {
      const editor = store.get().facts.editor;
      if (editor !== null && !editor.saving) close();
    }
  };
}
