import type { GenerationSettings } from "../../shared/types.js";
import { supportsAssistantPrefill } from "../../shared/continuation-plan.js";
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

/** Keep every UI field derived from server settings on one update path. */
export function applyGenerationSettings(
  state: GenerationRuntimeState,
  source: GenerationSettingsSource,
  settings: GenerationSettings
): void {
  source.settings = settings;
  Object.assign(state, deriveGenerationRuntime(settings, source.demo));
}
