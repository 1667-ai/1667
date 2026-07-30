import type {
  DiscoveredModelV2,
  ModelDiscoveryResultV2,
  SettingsView
} from "../../shared/settings-v2-types.js";
import type { GenerationSettings } from "../../shared/types.js";
import { selectSettingsRoute } from "../../shared/settings-route.js";
import type { ActionContext } from "./action-context.js";
import type { AppSource } from "./app.js";
import { settingsProviderProbeTarget } from "./settings-provider-probe.js";
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
    ? overlay.modelDiscovery?.models ?? []
    : [];
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
  settings: GenerationSettings;
  view: SettingsView;
  signal: AbortSignal;
}

export async function discoverSettingsModels(
  state: RuntimeState,
  source: Pick<AppSource, "api">,
  context: Pick<ActionContext, "backend" | "repaint">,
  overlay: SettingsOverlayState
): Promise<void> {
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
    settings,
    view: overlay.view,
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
        settingsProviderProbeTarget(request.view, request.settings),
        request.signal
      );
      if (!task.owns() || !ownsCurrentRequest(state, overlay, request)) return;
      publishModelDiscovery(overlay, request.identity, discovery);
      if (discovery.models.length === 0) {
        overlay.result = {
          state: "warning",
          message: "model list is empty · enter a custom name"
        };
      }
    } catch (error) {
      if (!task.owns() || !ownsCurrentRequest(state, overlay, request)) return;
      overlay.result = {
        state: "warning",
        message: "model list unavailable · enter a custom name"
      };
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

function settingsModelDiscoveryTargetIdentity(
  overlay: SettingsOverlayState
): string {
  const settings = overlay.view.editable
    ? overlay.draft.generation
    : overlay.view.effective;
  let connection: unknown = null;
  try {
    const target = settingsProviderProbeTarget(overlay.view, settings);
    if ("kind" in target) {
      connection = selectSettingsRoute(
        target.document,
        target.purpose
      ).connection;
    }
  } catch {
    connection = "invalid";
  }
  const secretIntent = Object.entries(overlay.connectionSecrets)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, value]) => [id, value === null ? "delete" : "replace"]);
  return JSON.stringify([
    settingsModelDiscoveryIdentity(settings),
    overlay.view.stateGeneration,
    connection,
    secretIntent
  ]);
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
    && settingsModelDiscoveryIdentity(current) === request.identity;
}

function publishModelDiscovery(
  overlay: SettingsOverlayState,
  identity: string,
  discovery: ModelDiscoveryResultV2
): void {
  overlay.modelDiscovery = discovery;
  overlay.modelDiscoveryIdentity = identity;
}
