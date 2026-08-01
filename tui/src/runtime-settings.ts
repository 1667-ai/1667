import type { GenerationSettings } from "../../shared/types.js";
import { supportsAssistantPrefill } from "../../shared/continuation-plan.js";
import type { SettingsView } from "../../shared/settings-v2-types.js";
import type { StoryScreenState } from "./state.js";

type GenerationRuntimeState = Pick<
  StoryScreenState,
  "model" | "contextWindow" | "maxTokens" | "systemPrompt" | "assistantPrefill"
>;

interface GenerationSettingsSource {
  settings: GenerationSettings;
  demo: boolean;
}

/** Startup and refresh share this policy. Demo fixtures name the model they
 * illustrate; a real dry-run backend names itself as such. */
export function deriveGenerationRuntime(
  settings: GenerationSettings,
  demo: boolean
): GenerationRuntimeState {
  return {
    model: demo ? settings.model : settings.provider === "dry-run" ? "dry-run" : settings.model,
    contextWindow: settings.contextWindow ?? null,
    maxTokens: settings.maxTokens,
    systemPrompt: settings.systemPrompt,
    assistantPrefill: supportsAssistantPrefill(settings)
  };
}

/** The server resolves the active prose route for the next-request meter.
 * This must not read the editable document, which can be a pending candidate. */
export function deriveContinuationRuntime(
  view: SettingsView,
  demo: boolean
): GenerationRuntimeState {
  return deriveGenerationRuntime(view.effectiveProse, demo);
}

/** Keep every UI field derived from server settings on one update path. */
export function applyGenerationSettings(
  state: GenerationRuntimeState,
  source: GenerationSettingsSource,
  view: SettingsView
): void {
  source.settings = view.effective;
  Object.assign(state, deriveContinuationRuntime(view, source.demo));
}
