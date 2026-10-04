import type { GenerationSettings } from "../../shared/types.js";
import type { SettingsView } from "../../shared/settings-v2-types.js";
import {
  deriveContinuationRuntime,
  generationRouteKey,
  type GenerationRuntimeState
} from "../../shared/runtime-settings.js";
import type { StoryScreenState } from "./state.js";

export { deriveContinuationRuntime, deriveGenerationRuntime, generationRouteKey } from "../../shared/runtime-settings.js";

interface GenerationSettingsSource {
  settings: GenerationSettings;
  demo: boolean;
}

/** Keep every UI field derived from server settings on one update path. */
export function applyGenerationSettings(
  state: GenerationRuntimeState & Pick<StoryScreenState, "generationRoute">,
  source: GenerationSettingsSource,
  view: SettingsView
): void {
  source.settings = view.effective;
  Object.assign(state, deriveContinuationRuntime(view, source.demo));
  state.generationRoute = generationRouteKey(view.effectiveProse);
}
