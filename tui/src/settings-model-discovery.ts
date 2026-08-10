import type {
  DiscoveredModelV2,
  ModelDiscoveryResultV2,
  SettingsDocumentV2,
  SettingsView
} from "../../shared/settings-v2-types.js";
import type { GenerationSettings } from "../../shared/types.js";
import type { ActionContext } from "./action-context.js";
import type { AppSource } from "./app.js";
import {
  settingsAutomaticModelSelection,
  settingsContextWindowIsManual,
} from "./settings-draft-transition.js";
import {
  applySettingsModelChoice,
  clearAutomaticSettingsModel
} from "./settings-model-selection.js";
import {
  settingsModelTargetFingerprint,
  settingsProviderProbeTarget
} from "./settings-provider-probe.js";
import type { RuntimeState, SettingsOverlayState } from "./state.js";

const synchronizedOverlays = new WeakMap<RuntimeState, SettingsOverlayState>();

export function settingsModelDiscoveryIdentity(
  settings: GenerationSettings
): string {
  return JSON.stringify([
    settings.provider,
    settings.baseUrl,
    settings.apiKeyEnv,
    settings.allowInsecureHttp === true
  ]);
}

export function settingsModelChoices(
  overlay: SettingsOverlayState
): readonly DiscoveredModelV2[] {
  return overlay.modelDiscoveryIdentity
      === settingsModelDiscoveryIdentity(overlay.draft.generation)
      && overlay.modelDiscoveryResultTargetIdentity
        === settingsModelSelectionScopeIdentity(overlay)
    ? overlay.modelDiscovery?.models ?? []
    : [];
}

export function publishCurrentSettingsModelDiscovery(
  overlay: SettingsOverlayState,
  discovery: ModelDiscoveryResultV2
): void {
  publishSettingsModelDiscoveryResult(
    overlay,
    discovery,
    settingsModelDiscoveryIdentity(overlay.draft.generation),
    settingsModelSelectionScopeIdentity(overlay)
  );
}

export function clearSettingsModelDiscovery(
  overlay: SettingsOverlayState
): void {
  overlay.modelDiscoveryAbortController?.abort();
  overlay.modelDiscoveryAbortController = null;
  overlay.modelDiscoveryGeneration += 1;
  overlay.discoveringModels = false;
  overlay.modelDiscovery = null;
  overlay.modelDiscoveryIdentity = null;
  overlay.modelDiscoveryResultTargetIdentity = null;
}

export async function synchronizeSettingsModelDiscovery(
  state: RuntimeState,
  source: Pick<AppSource, "api">,
  context: Pick<ActionContext, "backend" | "repaint">
): Promise<void> {
  const overlay = state.settings;
  const previous = synchronizedOverlays.get(state);
  if (previous !== undefined && previous !== overlay) {
    clearSettingsModelDiscovery(previous);
    previous.modelDiscoveryTargetIdentity = null;
  }
  if (overlay === null) {
    synchronizedOverlays.delete(state);
    return;
  }
  synchronizedOverlays.set(state, overlay);
  if (state.connection.down) {
    clearSettingsModelDiscovery(overlay);
    overlay.modelDiscoveryTargetIdentity = null;
    return;
  }
  const identity = settingsModelDiscoveryTargetIdentity(overlay);
  if (overlay.modelDiscoveryTargetIdentity === identity) return;
  overlay.modelDiscoveryTargetIdentity = identity;
  await discoverSettingsModels(state, source, context, overlay);
}

interface ModelDiscoveryRequest {
  generation: number;
  identity: string;
  targetIdentity: string;
  selectionTargetIdentity: string;
  selectionScopeIdentity: string;
  settings: GenerationSettings;
  view: SettingsView;
  document: SettingsDocumentV2 | null;
  profileId: string | null;
  signal: AbortSignal;
}

export async function discoverSettingsModels(
  state: RuntimeState,
  source: Pick<AppSource, "api">,
  context: Pick<ActionContext, "backend" | "repaint">,
  overlay: SettingsOverlayState
): Promise<void> {
  clearStaleAutomaticModel(overlay);
  const settings = overlay.view.editable
    ? overlay.draft.generation
    : overlay.view.effective;
  const identity = settingsModelDiscoveryIdentity(settings);
  clearSettingsModelDiscovery(overlay);
  if (!canDiscoverModels(settings)) return;
  const controller = new AbortController();
  overlay.modelDiscoveryAbortController = controller;
  const request: ModelDiscoveryRequest = {
    generation: overlay.modelDiscoveryGeneration,
    identity,
    targetIdentity: settingsModelDiscoveryTargetIdentity(overlay),
    selectionTargetIdentity: settingsModelSelectionTargetIdentity(overlay),
    selectionScopeIdentity: settingsModelSelectionScopeIdentity(overlay),
    settings,
    view: overlay.view,
    document: overlay.draft.document,
    profileId: overlay.draft.selectedProfileId,
    signal: controller.signal
  };
  overlay.discoveringModels = true;
  context.repaint();

  const admitted = await runModelDiscoveryRequest(
    state,
    source,
    context,
    overlay,
    request
  );
  if (!admitted && ownsCurrentRequest(state, overlay, request)) {
    context.backend.observe(retryModelDiscoveryWhenIdle(
      state,
      source,
      context,
      overlay,
      request
    ));
  }
}

async function runModelDiscoveryRequest(
  state: RuntimeState,
  source: Pick<AppSource, "api">,
  context: Pick<ActionContext, "backend" | "repaint">,
  overlay: SettingsOverlayState,
  request: ModelDiscoveryRequest
): Promise<boolean> {
  return context.backend.run("reading model list", async (task) => {
    if (!ownsCurrentRequest(state, overlay, request)) return;
    overlay.result = null;
    try {
      const discovery = await source.api.discoverModels(
        settingsProviderProbeTarget(
          request.view,
          request.settings,
          overlay.connectionSecrets,
          request.document,
          request.profileId
        ),
        request.signal
      );
      if (!task.owns() || !ownsCurrentRequest(state, overlay, request)) return;
      const selectionError = publishModelDiscovery(overlay, request, discovery);
      if (selectionError !== null) {
        overlay.result = {
          state: "warning",
          message: "model list loaded · choose the model manually"
        };
        overlay.resultRow = "model";
        state.toast = selectionError instanceof Error
          ? selectionError.message
          : String(selectionError);
      } else if (discovery.models.length === 0) {
        overlay.result = {
          state: "warning",
          message: `model list is empty · ${namedModelSuffix(overlay)}`
        };
        overlay.resultRow = "model";
      }
    } catch (error) {
      if (!task.owns() || !ownsCurrentRequest(state, overlay, request)) return;
      overlay.result = {
        state: "warning",
        message: `model list unavailable · ${namedModelSuffix(overlay)}`
      };
      overlay.resultRow = "model";
      state.toast = error instanceof Error ? error.message : String(error);
    } finally {
      if (task.owns() && ownsCurrentRequest(state, overlay, request)) {
        overlay.discoveringModels = false;
        overlay.modelDiscoveryAbortController = null;
      }
    }
  }, { reportBusy: false });
}

async function retryModelDiscoveryWhenIdle(
  state: RuntimeState,
  source: Pick<AppSource, "api">,
  context: Pick<ActionContext, "backend" | "repaint">,
  overlay: SettingsOverlayState,
  request: ModelDiscoveryRequest
): Promise<void> {
  while (ownsCurrentRequest(state, overlay, request)) {
    if (!await context.backend.whenIdle()) return;
    if (!ownsCurrentRequest(state, overlay, request)) return;
    const admitted = await runModelDiscoveryRequest(
      state,
      source,
      context,
      overlay,
      request
    );
    if (admitted) return;
  }
}

function canDiscoverModels(settings: GenerationSettings): boolean {
  if (settings.provider === "dry-run") return false;
  try {
    const protocol = new URL(settings.baseUrl).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function settingsModelSelectionTargetIdentity(
  overlay: SettingsOverlayState
): string {
  const settings = overlay.view.editable
    ? overlay.draft.generation
    : overlay.view.effective;
  try {
    return settingsModelTargetFingerprint(
      overlay.view,
      settings,
      overlay.connectionSecrets,
      overlay.draft.document,
      overlay.draft.selectedProfileId
    );
  } catch {
    return JSON.stringify([
      "invalid",
      settingsModelDiscoveryIdentity(settings)
    ]);
  }
}

function settingsModelSelectionScopeIdentity(
  overlay: SettingsOverlayState
): string {
  return JSON.stringify([
    overlay.draft.selectedProfileId,
    settingsModelSelectionTargetIdentity(overlay)
  ]);
}

function settingsModelDiscoveryTargetIdentity(
  overlay: SettingsOverlayState
): string {
  return JSON.stringify([
    overlay.view.stateGeneration,
    settingsModelSelectionScopeIdentity(overlay)
  ]);
}

function clearStaleAutomaticModel(overlay: SettingsOverlayState): void {
  const automatic = settingsAutomaticModelSelection(overlay);
  if (automatic !== null
    && automatic.targetIdentity !== settingsModelSelectionTargetIdentity(overlay)) {
    clearAutomaticSettingsModel(overlay);
  }
}

function ownsCurrentRequest(
  state: RuntimeState,
  overlay: SettingsOverlayState,
  request: ModelDiscoveryRequest
): boolean {
  const current = overlay.view.editable
    ? overlay.draft.generation
    : overlay.view.effective;
  return state.settings === overlay
    && overlay.modelDiscoveryGeneration === request.generation
    && overlay.draft.selectedProfileId === request.profileId
    && settingsModelDiscoveryTargetIdentity(overlay) === request.targetIdentity
    && settingsModelDiscoveryIdentity(current) === request.identity;
}

function publishModelDiscovery(
  overlay: SettingsOverlayState,
  request: ModelDiscoveryRequest,
  discovery: ModelDiscoveryResultV2
): unknown | null {
  publishSettingsModelDiscoveryResult(
    overlay,
    discovery,
    request.identity,
    request.selectionScopeIdentity
  );
  const onlyModel = discovery.models.length === 1
    ? discovery.models[0]
    : undefined;
  const currentModel = overlay.draft.generation.model;
  const automatic = settingsAutomaticModelSelection(overlay);
  if (!overlay.view.editable
    || (currentModel.trim().length > 0 && automatic === null)) {
    return null;
  }
  const listedModel = automatic === null
      || automatic.targetIdentity !== request.selectionTargetIdentity
    ? undefined
    : discovery.models.find((model) => model.remoteId === automatic.remoteId);
  const selected = listedModel ?? onlyModel;
  if (selected === undefined) {
    if (automatic !== null) clearAutomaticSettingsModel(overlay);
    return null;
  }
  const contextWindow = settingsContextWindowIsManual(overlay)
    ? overlay.draft.generation.contextWindow
    : selected.contextWindow;
  try {
    applySettingsModelChoice(
      overlay,
      selected,
      contextWindow,
      {
        kind: "automatic",
        targetIdentity: request.selectionTargetIdentity
      }
    );
    return null;
  } catch (error) {
    return error;
  }
}

function publishSettingsModelDiscoveryResult(
  overlay: SettingsOverlayState,
  discovery: ModelDiscoveryResultV2,
  identity: string,
  targetIdentity: string
): void {
  overlay.modelDiscovery = discovery;
  overlay.modelDiscoveryIdentity = identity;
  overlay.modelDiscoveryResultTargetIdentity = targetIdentity;
}

/** What to say after a discovery failure. Telling a writer to "enter a custom
 *  name" when they have just entered one reads as the app ignoring them. */
function namedModelSuffix(overlay: SettingsOverlayState): string {
  return overlay.draft.generation.model.trim().length === 0
    ? "type a model name"
    : "using the name you typed";
}
