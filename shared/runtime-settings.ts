import type { GenerationSettings } from "./types.js";
import { supportsAssistantPrefill } from "./continuation-plan.js";
import type { ContinuationPromptLayout } from "./continuation-prompt-optimization.js";
import type { ReasoningDisplayV2, SettingsView } from "./settings-v2-types.js";
import { writingPromptSettingsFromAuthorBrief, type WritingPromptSettings } from "./settings-v5-writing.js";

/** The generation settings a next-request projection reads, in the form every
 * surface (the TUI story screen and the web composer) keeps them. */
export interface GenerationRuntimeState {
  model: string;
  contextWindow: number | null;
  maxTokens: number;
  systemPrompt: string;
  assistantPrefill: boolean;
  reasoning: ReasoningDisplayV2;
  continuationPromptLayout: ContinuationPromptLayout;
  activeWriting: WritingPromptSettings;
}

/** Startup and refresh share this policy. Demo fixtures name the model they
 * illustrate; a real dry-run backend names itself as such. */
export function deriveGenerationRuntime(
  settings: GenerationSettings,
  demo: boolean,
  reasoning: ReasoningDisplayV2 = "marker",
  continuationPromptLayout: ContinuationPromptLayout = "compatibility"
): GenerationRuntimeState {
  return {
    model: demo ? settings.model : settings.provider === "dry-run" ? "dry-run" : settings.model,
    contextWindow: settings.contextWindow ?? null,
    maxTokens: settings.maxTokens,
    systemPrompt: settings.systemPrompt,
    assistantPrefill: supportsAssistantPrefill(settings),
    reasoning,
    continuationPromptLayout,
    activeWriting: writingPromptSettingsFromAuthorBrief(settings.systemPrompt)
  };
}

/** The server resolves the active prose route for the next-request meter.
 * This must not read the editable document, which can be a pending candidate
 * — `effectiveProse`, `effectiveProseReasoning`, and
 * `effectiveProseContinuationPromptLayout` are already resolved server-side
 * against the active (never pending) document, the same way `model` is. */
export function deriveContinuationRuntime(
  view: SettingsView,
  demo: boolean
): GenerationRuntimeState {
  const continuationPromptLayout = view.effectiveProseContinuationPromptLayout ?? "compatibility";
  return {
    ...deriveGenerationRuntime(
      view.effectiveProse,
      demo,
      view.effectiveProseReasoning ?? "marker",
      continuationPromptLayout
    ),
    activeWriting: view.activeWriting
  };
}

/** What identifies the route a token count was taken against, so a count can
 * be retired when the route changes and kept when it did not. It mirrors the
 * scope the backend already caches under (see server/tokenize-probe.ts): the
 * provider, the endpoint, and the model decide both the number and its grade.
 *
 * A counter of settings publications would not do. Settings republish when the
 * writer merely opens the panel, and on every reconnect, and none of that
 * changes what the tokens are. */
export function generationRouteKey(settings: GenerationSettings): string {
  return [settings.provider, settings.baseUrl, settings.model].join("\0");
}
