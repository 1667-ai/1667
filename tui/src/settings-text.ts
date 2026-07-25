import {
  PROMPT_CACHE_POLICY_V2_VALUES,
  type PromptCachePolicyV2,
  type SettingsView
} from "../../shared/settings-v2-types.js";
import {
  PROVIDER_VALUES,
  type GenerationSettings,
  type Provider
} from "../../shared/types.js";
import { basicSettingsForDisplay } from "../../shared/settings-basic-draft.js";
import { promptCacheContextForDocument } from "../../shared/prompt-cache-capabilities.js";

export interface SettingsTextDraft {
  readonly generation: GenerationSettings;
  readonly cachePolicy: PromptCachePolicyV2;
}

export function settingsTextDraftForView(view: SettingsView): SettingsTextDraft {
  return {
    generation: basicSettingsForDisplay(view),
    cachePolicy: view.editable
      ? promptCacheContextForDocument(view.document).policy
      : "off"
  };
}

/** Draft serialization contract for generation settings: `key: value` lines, ≻ guidance
 *  stripped, unknown keys rejected so typos fail loudly instead of silently. */
export function serializeSettings(draft: SettingsTextDraft): string {
  const settings = draft.generation;
  return [
    "≻ 1667 · generation settings · key: value per line · ≻ lines are stripped.",
    "≻ provider is openai-compatible | anthropic | dry-run · blank apiKeyEnv means none.",
    "≻ Advanced cachePolicy is off | auto | long · exact provider/model support is required.",
    `provider: ${settings.provider}`,
    `baseUrl: ${settings.baseUrl}`,
    `model: ${settings.model}`,
    `apiKeyEnv: ${settings.apiKeyEnv ?? ""}`,
    `temperature: ${settings.temperature}`,
    `maxTokens: ${settings.maxTokens}`,
    `contextWindow: ${settings.contextWindow ?? ""}`,
    `cachePolicy: ${draft.cachePolicy}`,
    `systemPrompt: ${settings.systemPrompt.replace(/\n/g, " ")}`
  ].join("\n");
}

export function parseSettings(value: string, base: SettingsTextDraft): SettingsTextDraft | { error: string } {
  const next = { ...base.generation };
  let cachePolicy = base.cachePolicy;
  for (const raw of value.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("≻")) continue;
    const divider = line.indexOf(":");
    if (divider === -1) return { error: `not key: value — "${line.slice(0, 40)}"` };
    const key = line.slice(0, divider).trim();
    const text = line.slice(divider + 1).trim();
    if (key === "provider") {
      if (!PROVIDER_VALUES.includes(text as Provider)) {
        return { error: `provider must be openai-compatible, anthropic, or dry-run — "${text}"` };
      }
      next.provider = text as Provider;
    }
    else if (key === "baseUrl") next.baseUrl = text;
    else if (key === "model") next.model = text;
    else if (key === "apiKeyEnv") next.apiKeyEnv = text.length === 0 ? null : text;
    else if (key === "systemPrompt") next.systemPrompt = text;
    else if (key === "temperature") {
      if (text.length === 0) next.temperature = null;
      else {
        const parsed = Number(text);
        if (!Number.isFinite(parsed)) return { error: `temperature is not a number or blank — "${text}"` };
        next.temperature = parsed;
      }
    } else if (key === "maxTokens") {
      const parsed = Number(text);
      if (!Number.isInteger(parsed) || parsed <= 0) return { error: `maxTokens must be a positive integer — "${text}"` };
      next.maxTokens = parsed;
    } else if (key === "contextWindow") {
      if (text.length === 0) next.contextWindow = null;
      else {
        const parsed = Number(text);
        if (!Number.isInteger(parsed) || parsed <= 0) return { error: `contextWindow must be a positive integer or blank — "${text}"` };
        next.contextWindow = parsed;
      }
    } else if (key === "cachePolicy") {
      if (!PROMPT_CACHE_POLICY_V2_VALUES.includes(text as PromptCachePolicyV2)) {
        return { error: `cachePolicy must be off, auto, or long — "${text}"` };
      }
      cachePolicy = text as PromptCachePolicyV2;
    } else return { error: `unknown setting "${key}"` };
  }
  return { generation: next, cachePolicy };
}
