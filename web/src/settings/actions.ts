import { apiErrorCode } from "../../../client/api-error.js";
import type { StoryApi } from "../../../client/api.js";
import { createDurableMutationId } from "../../../shared/durable-mutation-id.js";
import { SETTINGS_PROVIDER_CHOICES, type SettingsProviderChoiceId } from "../../../shared/settings-provider-choices.js";
import { settingsActivationFailureText } from "../../../shared/settings-activation-text.js";
import { settingsMutationFailureAction } from "../../../shared/settings-mutation-failure.js";
import { buildSettingsSaveDocument } from "../../../shared/settings-save-document.js";
import {
  settingsSubscriptionAutoPreset,
  settingsSubscriptionLoginHint
} from "../../../shared/settings-subscription-plan.js";
import { settingsTextDraftForView } from "../../../shared/settings-text-draft.js";
import { settingsTextDraftWithMergedWriting } from "../../../shared/settings-writing-draft.js";
import type { DiscoveredModelV2, SettingsView } from "../../../shared/settings-v2-types.js";
import type { WritingPromptFieldId } from "../../../shared/settings-v5-writing.js";
import { retryWhenBusy } from "../app/busy-retry.js";
import type { AppState } from "../app/state.js";
import type { Store } from "../app/store.js";
import { errorMessage, pushToast } from "../app/toasts.js";
import {
  applyAllowInsecureHttp,
  applyApiKey,
  applyBaseUrl,
  applyContextText,
  applyDetectedContext,
  applyModel,
  applyProviderChoice,
  applyWritingText,
  canDiscoverModels,
  draftsEqual,
  invalidCount,
  isDirty,
  isSubscriptionDraft,
  probeTargetFor,
  selectedPreset,
  targetIdentity,
  type SettingsEdit
} from "./model.js";
import type { LoadedSettings, InvalidField } from "./state.js";

/** A change of the connection waits this long before the model list is read
 * again, so typing a URL asks the server once. */
const DISCOVERY_DEBOUNCE_MS = 500;
/** A model change waits this long before the context size is probed. */
const PROBE_DEBOUNCE_MS = 500;

const CHANGED_ELSEWHERE = "Settings changed elsewhere. Your changes are kept. Save again to overwrite.";
const OUTCOME_UNKNOWN = "Could not check whether settings saved. Try again.";

export interface SettingsActions {
  /** The page opened: load the settings, or keep the draft that is there. */
  open(): void;
  /** The page closed: stop what runs for it. The draft stays. */
  leave(): void;
  /** The window got focus: read the settings again when nothing is changed. */
  reloadIfClean(): void;
  retryLoad(): void;
  chooseProvider(id: SettingsProviderChoiceId): void;
  setBaseUrl(text: string): void;
  setAllowInsecureHttp(on: boolean): void;
  setApiKey(value: string): void;
  removeApiKey(): void;
  setModel(text: string): void;
  pickModel(model: DiscoveredModelV2): void;
  refreshModels(): void;
  setContextSize(text: string): void;
  setWriting(field: WritingPromptFieldId, text: string): void;
  check(): Promise<void>;
  probeContext(): Promise<void>;
  save(): Promise<void>;
  discardDraft(): void;
  discardPending(): Promise<void>;
}

function requireApi(store: Store<AppState>): StoryApi {
  const connection = store.get().connection;
  if (connection.kind !== "connected") throw new Error("1667 web: not connected");
  return connection.api;
}

function sameSecrets(
  left: Readonly<Record<string, string | null>>,
  right: Readonly<Record<string, string | null>>
): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}

/** The settings page's state and every change to it (#409 step 9b). Edits go
 * through the shared draft core (`shared/settings-*.ts`), the same code the
 * terminal uses. Nothing here keeps a key outside the store's memory. */
export function createSettingsActions(store: Store<AppState>): SettingsActions {
  let loadTicket = 0;
  let discoveryTimer: ReturnType<typeof setTimeout> | null = null;
  let discoveryAbort: AbortController | null = null;
  let probeTimer: ReturnType<typeof setTimeout> | null = null;
  let probeTicket = 0;

  const loaded = (): LoadedSettings | null => {
    const settings = store.get().settings;
    return settings.kind === "loaded" ? settings : null;
  };
  const patch = (change: (current: LoadedSettings) => LoadedSettings): void => {
    store.set((state) => (state.settings.kind === "loaded" ? { ...state, settings: change(state.settings) } : state));
  };
  const setNotice = (tone: "info" | "error", text: string): void => {
    patch((current) => ({ ...current, notice: { tone, text } }));
  };

  function freshLoaded(view: SettingsView, previous: LoadedSettings | null, applyAutoPlan: boolean): LoadedSettings {
    const base = settingsTextDraftForView(view, previous?.draft.selectedProfileId);
    let draft = base;
    let secrets: LoadedSettings["secrets"] = {};
    const plan = applyAutoPlan && view.editable && view.subscriptionAutoSelectEligible === true
      ? settingsSubscriptionAutoPreset(view)
      : null;
    if (plan !== null) {
      const choice = SETTINGS_PROVIDER_CHOICES.find((candidate) => candidate.id === plan);
      if (choice !== undefined) ({ draft, secrets } = applyProviderChoice({ draft, secrets }, choice));
    }
    return {
      kind: "loaded",
      view,
      base,
      draft,
      secrets,
      invalid: {},
      discovery: previous?.discovery ?? null,
      check: null,
      probe: null,
      busy: null,
      saveIntent: null,
      discardIntent: null,
      notice: null,
      keyEpoch: (previous?.keyEpoch ?? 0) + 1
    };
  }

  async function load(silent: boolean): Promise<void> {
    const ticket = ++loadTicket;
    if (!silent) store.set((state) => ({ ...state, settings: { kind: "loading" } }));
    try {
      const view = await retryWhenBusy(() => requireApi(store).getSettings());
      if (ticket !== loadTicket) return;
      store.set((state) => {
        const current = state.settings.kind === "loaded" ? state.settings : null;
        // A draft with changes, or a save that may still be unsettled, is the
        // writer's: the fresh view never replaces it.
        if (current !== null && (isDirty(current) || current.saveIntent !== null || current.discardIntent !== null
          || current.busy !== null)) return state;
        return { ...state, settings: freshLoaded(view, current, current === null) };
      });
      syncDiscovery(true);
      scheduleProbe();
    } catch (error) {
      if (ticket !== loadTicket || silent) return;
      store.set((state) => ({ ...state, settings: { kind: "failed", message: errorMessage(error) } }));
    }
  }

  // --- model list ---------------------------------------------------------

  function stopDiscovery(): void {
    if (discoveryTimer !== null) clearTimeout(discoveryTimer);
    discoveryTimer = null;
    discoveryAbort?.abort();
    discoveryAbort = null;
  }

  /** Keeps the model list in step with the connection target: a new target
   * clears the list and reads it again (debounced, abortable). */
  function syncDiscovery(immediate: boolean, force = false): void {
    const current = loaded();
    if (current === null) return;
    if (!current.view.editable || !canDiscoverModels(current.draft)) {
      stopDiscovery();
      if (current.discovery !== null) patch((state) => ({ ...state, discovery: null }));
      return;
    }
    const target = targetIdentity(current);
    if (!force && current.discovery !== null && current.discovery.target === target) return;
    stopDiscovery();
    patch((state) => ({ ...state, discovery: { target, kind: "loading" } }));
    const run = (): void => { void discover(target); };
    if (immediate) run();
    else discoveryTimer = setTimeout(run, DISCOVERY_DEBOUNCE_MS);
  }

  async function discover(target: string): Promise<void> {
    discoveryTimer = null;
    const current = loaded();
    if (current === null || targetIdentity(current) !== target) return;
    const controller = new AbortController();
    discoveryAbort = controller;
    try {
      const result = await requireApi(store).discoverModels(probeTargetFor(current), controller.signal);
      const now = loaded();
      if (controller.signal.aborted || now === null || targetIdentity(now) !== target) return;
      patch((state) => ({
        ...state,
        discovery: { target, kind: "ready", models: result.models, observedAt: result.observedAt }
      }));
      // The only model a server lists is the one to use, when none is chosen.
      const only = result.models.length === 1 ? result.models[0]! : null;
      if (only !== null && now.draft.generation.model.trim().length === 0) pickModel(only);
    } catch (error) {
      if (controller.signal.aborted) return;
      const now = loaded();
      if (now === null || targetIdentity(now) !== target) return;
      patch((state) => ({ ...state, discovery: { target, kind: "failed", message: errorMessage(error) } }));
    } finally {
      if (discoveryAbort === controller) discoveryAbort = null;
    }
  }

  // --- context size -------------------------------------------------------

  function needsProbe(current: LoadedSettings): boolean {
    return current.view.editable && current.draft.document !== null
      && current.draft.generation.model.trim().length > 0
      && current.draft.generation.contextWindow === null
      && !isSubscriptionDraft(current.draft);
  }

  function scheduleProbe(): void {
    if (probeTimer !== null) clearTimeout(probeTimer);
    probeTimer = null;
    const current = loaded();
    if (current === null || !needsProbe(current)) return;
    probeTimer = setTimeout(() => {
      probeTimer = null;
      const now = loaded();
      if (now !== null && needsProbe(now)) void probe();
    }, PROBE_DEBOUNCE_MS);
  }

  async function probe(): Promise<void> {
    const current = loaded();
    if (current === null || !current.view.editable) return;
    const preset = selectedPreset(current.draft);
    if (preset === "chatgpt-plan" || preset === "claude-plan") {
      patch((state) => ({
        ...state,
        probe: {
          kind: "done",
          state: "warning",
          message: `${settingsSubscriptionLoginHint(preset, state.view.subscriptionAuth)} Enter the context size here.`
        }
      }));
      return;
    }
    const ticket = ++probeTicket;
    const target = targetIdentity(current);
    const model = current.draft.generation.model;
    const context = current.draft.generation.contextWindow;
    patch((state) => ({ ...state, probe: { kind: "probing" } }));
    const stale = (): boolean => {
      const now = loaded();
      return ticket !== probeTicket || now === null || targetIdentity(now) !== target
        || now.draft.generation.model !== model || now.draft.generation.contextWindow !== context;
    };
    try {
      const { contextWindow } = await requireApi(store).probeContextWindow(probeTargetFor(current));
      if (stale()) {
        if (ticket === probeTicket) patch((state) => ({ ...state, probe: null }));
        return;
      }
      if (contextWindow === null) {
        patch((state) => ({
          ...state,
          probe: { kind: "done", state: "warning", message: "The server did not report a context size. Enter it here." }
        }));
        return;
      }
      applyEdit((edit) => applyDetectedContext(edit, contextWindow), { probe: {
        kind: "done", state: "ready", message: `The server reports ${contextWindow.toLocaleString("en-US")} tokens.`
      } });
    } catch (error) {
      if (stale()) return;
      patch((state) => ({
        ...state,
        probe: { kind: "done", state: "warning", message: `Context probe failed: ${errorMessage(error)}` }
      }));
    }
  }

  // --- edits --------------------------------------------------------------

  /** One change of the draft. The form is locked while a save runs. */
  function applyEdit(
    change: (edit: SettingsEdit) => SettingsEdit,
    extra: Partial<Pick<LoadedSettings, "probe">> = {}
  ): void {
    const current = loaded();
    if (current === null || !current.view.editable || current.busy !== null) return;
    const before: SettingsEdit = { draft: current.draft, secrets: current.secrets };
    const after = change(before);
    if (after === before && Object.keys(extra).length === 0) return;
    patch((state) => ({
      ...state,
      draft: after.draft,
      secrets: after.secrets,
      ...extra
    }));
    syncDiscovery(false);
    scheduleProbe();
  }

  const setInvalid = (key: string, invalid: InvalidField | null): void => {
    patch((state) => {
      if (invalid === null && state.invalid[key] === undefined) return state;
      const next = { ...state.invalid };
      if (invalid === null) delete next[key];
      else next[key] = invalid;
      return { ...state, invalid: next };
    });
  };

  function pickModel(model: DiscoveredModelV2): void {
    applyEdit((edit) => applyModel(edit, model.remoteId, model.contextWindow));
  }

  // --- save ---------------------------------------------------------------

  async function reloadView(): Promise<SettingsView | null> {
    try {
      return await retryWhenBusy(() => requireApi(store).getSettings());
    } catch {
      return null;
    }
  }

  async function save(): Promise<void> {
    const current = loaded();
    if (current === null || !current.view.editable || current.busy !== null) return;
    if (store.get().connection.kind !== "connected") {
      setNotice("error", "Offline. Your changes are kept until the connection returns.");
      return;
    }
    if (invalidCount(current) > 0) return;
    const staged = current.view.pendingRevision !== null;
    if (current.saveIntent === null && !isDirty(current) && !staged) return;

    let intent = current.saveIntent;
    if (intent === null) {
      try {
        const discovery = current.discovery?.kind === "ready" && current.discovery.target === targetIdentity(current)
          ? { observedAt: current.discovery.observedAt, models: current.discovery.models }
          : null;
        const document = buildSettingsSaveDocument(current.draft, discovery);
        const secrets = current.secrets;
        intent = {
          command: {
            mutationId: createDurableMutationId(),
            expectedStateGeneration: current.view.stateGeneration,
            document,
            ...(Object.keys(secrets).length === 0 ? {} : { connectionSecrets: { ...secrets } })
          },
          draft: current.draft,
          secrets
        };
      } catch (error) {
        setNotice("error", `Settings kept. ${errorMessage(error)}`);
        return;
      }
    }
    const sent = intent;
    patch((state) => ({ ...state, busy: "save", saveIntent: sent, notice: null }));
    let result;
    try {
      result = await retryWhenBusy(() => requireApi(store).saveSettings({
        ...sent.command,
        transportOperationId: crypto.randomUUID()
      }));
    } catch (error) {
      const action = settingsMutationFailureAction(apiErrorCode(error));
      if (action === "retain") {
        patch((state) => ({ ...state, busy: null, notice: { tone: "error", text: OUTCOME_UNKNOWN } }));
        return;
      }
      if (action === "retire") {
        patch((state) => ({
          ...state,
          busy: null,
          saveIntent: null,
          notice: { tone: "error", text: `Settings not saved. ${errorMessage(error)}` }
        }));
        return;
      }
      const view = await reloadView();
      patch((state) => {
        const next = { ...state, busy: null, saveIntent: null } as LoadedSettings;
        if (view === null) return { ...next, notice: { tone: "error", text: CHANGED_ELSEWHERE } };
        const base = settingsTextDraftForView(view, state.draft.selectedProfileId);
        return {
          ...next,
          view,
          base,
          draft: settingsTextDraftWithMergedWriting(state.draft, state.base, base),
          notice: { tone: "error", text: CHANGED_ELSEWHERE }
        };
      });
      return;
    }
    const view = await reloadView();
    const outcome = result.activationOutcome;
    // Saved but not active: a failed activation, or one still pending. The bar
    // then says so (from the view), and a toast would say the opposite.
    const notActive = outcome === null ? result.pendingSettingsRevision !== null : outcome.result !== "committed";
    let newerEdits = false;
    patch((state) => {
      const settled = { ...state, busy: null, saveIntent: null } as LoadedSettings;
      if (view === null) return settled;
      newerEdits = !draftsEqual(state.draft, sent.draft) || !sameSecrets(state.secrets, sent.secrets);
      const base = settingsTextDraftForView(view, state.draft.selectedProfileId);
      return {
        ...settled,
        view,
        base,
        draft: newerEdits ? state.draft : base,
        secrets: newerEdits ? state.secrets : {},
        invalid: newerEdits ? state.invalid : {},
        keyEpoch: state.keyEpoch + 1
      };
    });
    if (view === null) {
      pushToast(store, "Settings saved, but they could not be read back. Reload the page.");
    } else if (!notActive) {
      pushToast(store, newerEdits ? "Settings saved. Newer edits kept." : "Settings saved");
    }
    syncDiscovery(false);
    scheduleProbe();
  }

  async function discardPending(): Promise<void> {
    const current = loaded();
    if (current === null || !current.view.editable || current.busy !== null || current.view.pendingRevision === null) return;
    const intent = current.discardIntent ?? {
      mutationId: createDurableMutationId(),
      expectedStateGeneration: current.view.stateGeneration
    };
    patch((state) => ({ ...state, busy: "discard", discardIntent: intent, notice: null }));
    let refreshed = false;
    try {
      await retryWhenBusy(() => requireApi(store).discardPendingSettings({
        ...intent,
        transportOperationId: crypto.randomUUID()
      }));
    } catch (error) {
      const action = settingsMutationFailureAction(apiErrorCode(error));
      if (action === "retain") {
        patch((state) => ({ ...state, busy: null, notice: { tone: "error", text: OUTCOME_UNKNOWN } }));
        return;
      }
      if (action === "retire") {
        patch((state) => ({
          ...state,
          busy: null,
          discardIntent: null,
          notice: { tone: "error", text: `Pending settings not discarded. ${errorMessage(error)}` }
        }));
        return;
      }
      refreshed = true;
    }
    const view = await reloadView();
    patch((state) => {
      const settled = { ...state, busy: null, discardIntent: null } as LoadedSettings;
      if (view === null) return settled;
      const clean = !isDirty(state);
      const base = settingsTextDraftForView(view, state.draft.selectedProfileId);
      return {
        ...settled,
        view,
        base,
        draft: clean ? base : state.draft,
        notice: refreshed ? { tone: "error", text: "Settings changed elsewhere. The latest settings are loaded." } : null
      };
    });
    if (!refreshed) pushToast(store, "Pending settings discarded");
  }

  return {
    open: () => {
      const settings = store.get().settings;
      if (settings.kind === "loaded") {
        void load(true);
        syncDiscovery(true);
        scheduleProbe();
      } else if (settings.kind !== "loading") void load(false);
    },
    leave: () => {
      stopDiscovery();
      if (probeTimer !== null) clearTimeout(probeTimer);
      probeTimer = null;
      patch((state) => ({
        ...state,
        discovery: state.discovery?.kind === "loading" ? null : state.discovery,
        probe: state.probe?.kind === "probing" ? null : state.probe
      }));
      probeTicket += 1;
    },
    reloadIfClean: () => {
      const current = loaded();
      if (current !== null && !isDirty(current)) void load(true);
    },
    retryLoad: () => { void load(false); },
    chooseProvider: (id) => {
      const choice = SETTINGS_PROVIDER_CHOICES.find((candidate) => candidate.id === id);
      if (choice !== undefined) applyEdit((edit) => applyProviderChoice(edit, choice));
    },
    setBaseUrl: (text) => applyEdit((edit) => applyBaseUrl(edit, text)),
    setAllowInsecureHttp: (on) => applyEdit((edit) => applyAllowInsecureHttp(edit, on)),
    setApiKey: (value) => {
      const current = loaded();
      if (current === null || current.busy !== null) return;
      const result = applyApiKey({ draft: current.draft, secrets: current.secrets }, value);
      // A refused key is never kept: only the reason is.
      if ("error" in result) setInvalid("api-key", { text: "", reason: result.error });
      else {
        setInvalid("api-key", null);
        applyEdit(() => result.edit);
      }
    },
    removeApiKey: () => {
      applyEdit((edit) => {
        const result = applyApiKey(edit, "");
        return "edit" in result ? result.edit : edit;
      });
      patch((state) => ({ ...state, keyEpoch: state.keyEpoch + 1 }));
    },
    setModel: (text) => applyEdit((edit) => applyModel(edit, text.trim())),
    pickModel,
    refreshModels: () => syncDiscovery(true, true),
    setContextSize: (text) => {
      const current = loaded();
      if (current === null || !current.view.editable || current.busy !== null) return;
      const result = applyContextText({ draft: current.draft, secrets: current.secrets }, text);
      if ("error" in result) {
        setInvalid("context", { text, reason: result.error });
        return;
      }
      setInvalid("context", null);
      applyEdit(() => result.edit);
    },
    setWriting: (field, text) => {
      const current = loaded();
      if (current === null || !current.view.editable || current.busy !== null) return;
      const result = applyWritingText({ draft: current.draft, secrets: current.secrets }, field, text);
      if ("error" in result) {
        setInvalid(field, { text, reason: result.error });
        return;
      }
      setInvalid(field, null);
      applyEdit(() => result.edit);
    },
    check: async () => {
      const current = loaded();
      if (current === null || !current.view.editable || current.busy !== null) return;
      const target = targetIdentity(current);
      const preset = selectedPreset(current.draft);
      if (preset === "chatgpt-plan" || preset === "claude-plan") {
        patch((state) => ({
          ...state,
          check: {
            target,
            kind: "done",
            result: {
              state: "warning",
              message: `${settingsSubscriptionLoginHint(preset, state.view.subscriptionAuth)} The connection check is not available for a plan.`
            }
          }
        }));
        return;
      }
      patch((state) => ({ ...state, check: { target, kind: "checking" } }));
      try {
        const result = await requireApi(store).checkModelServer(probeTargetFor(current));
        patch((state) => ({ ...state, check: { target, kind: "done", result } }));
      } catch (error) {
        patch((state) => ({
          ...state,
          check: { target, kind: "done", result: { state: "error", message: errorMessage(error) } }
        }));
      }
    },
    probeContext: probe,
    save,
    discardDraft: () => {
      const current = loaded();
      if (current === null || current.busy !== null) return;
      patch((state) => ({
        ...state,
        draft: state.base,
        secrets: {},
        invalid: {},
        saveIntent: null,
        notice: null,
        probe: null,
        keyEpoch: state.keyEpoch + 1
      }));
      syncDiscovery(false);
    },
    discardPending
  };
}

/** The line the bar shows while saved settings are not active yet. */
export function notActiveText(view: SettingsView): string | null {
  if (!view.editable || view.pendingRevision === null) return null;
  const outcome = view.lastActivationOutcome;
  if (outcome === null || outcome.result === "committed") return "Saved, not active yet.";
  return `Saved, not active: ${settingsActivationFailureText(outcome.errorCode)}.`;
}
