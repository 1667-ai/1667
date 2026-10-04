import {
  PROMPT_CACHE_POLICY_V2_VALUES,
  type SamplingSettingsV2,
  type PromptCachePolicyV2
} from "../../shared/settings-v2-types.js";
import {
  PROVIDER_VALUES,
  type Provider
} from "../../shared/types.js";
import {
  SAMPLING_SCALAR_KNOBS,
  validateSamplingBannedStrings,
  validateSamplingDryBreakers,
  validateSamplingLogitBias,
  validateSamplingPhraseBias,
  validateSamplingScalar,
  validateSamplingStopSequences,
  type SamplingScalarKnob
} from "../../shared/sampling-validation-policy.js";
import type { SettingsTextDraft } from "../../shared/settings-text-draft.js";

// The draft model lives in shared/ so the web reuses it. This module keeps the
// terminal's `key: value` text parser and printer.
export * from "../../shared/settings-text-draft.js";

const SAMPLING_SCALAR_KEYS: ReadonlySet<string> = new Set(
  SAMPLING_SCALAR_KNOBS.map((key) => `sampling.${key}`)
);

/** The two sampling knobs that hold a list of strings. Both parse the same
 *  way, so the key carries its own field and bound rather than growing a
 *  second copy of the branch. A Map keeps an object key such as
 *  `constructor` from resolving to something that is not a setting. */
const SAMPLING_STRING_LISTS: ReadonlyMap<string, {
  readonly field: "stop" | "dryBreakers";
  readonly validate: (value: unknown, label: string) => readonly string[];
}> = new Map([
  ["sampling.stop", { field: "stop" as const, validate: validateSamplingStopSequences }],
  ["sampling.dryBreakers", { field: "dryBreakers" as const, validate: validateSamplingDryBreakers }]
]);

/** Draft serialization contract for generation settings: `key: value` lines, ≻ guidance
 *  stripped, unknown keys rejected so typos fail loudly instead of silently. */
export function serializeSettings(draft: SettingsTextDraft): string {
  const settings = draft.generation;
  return [
    "≻ 1667 · generation settings · key: value per line · ≻ lines are stripped.",
    "≻ provider is openai-compatible | text-completion | anthropic | dry-run · blank apiKeyEnv means none.",
    "≻ Advanced cachePolicy is off | auto | long · exact provider/model support is required.",
    `provider: ${settings.provider}`,
    `baseUrl: ${settings.baseUrl}`,
    `allowInsecureHttp: ${settings.allowInsecureHttp === true}`,
    `model: ${settings.model}`,
    `apiKeyEnv: ${settings.apiKeyEnv ?? ""}`,
    `temperature: ${settings.temperature}`,
    `maxTokens: ${settings.maxTokens}`,
    `contextWindow: ${settings.contextWindow ?? ""}`,
    `cachePolicy: ${draft.cachePolicy}`,
    // Derived from the knob list, so a new sampling parameter reaches this
    // surface with the rest of them rather than going missing here alone.
    ...SAMPLING_SCALAR_KNOBS.map((knob) => `sampling.${knob}: ${draft.sampling[knob] ?? ""}`),
    `sampling.stop: ${JSON.stringify(draft.sampling.stop)}`,
    `sampling.dryBreakers: ${JSON.stringify(draft.sampling.dryBreakers)}`,
    `sampling.logitBias: ${JSON.stringify(draft.sampling.logitBias)}`,
    `sampling.bannedStrings: ${JSON.stringify(draft.sampling.bannedStrings)}`,
    `sampling.phraseBias: ${JSON.stringify(draft.sampling.phraseBias)}`,
    `systemPrompt: ${settings.systemPrompt.replace(/\n/g, " ")}`
  ].join("\n");
}

export function parseSettings(value: string, base: SettingsTextDraft): SettingsTextDraft | { error: string } {
  const next = { ...base.generation };
  let cachePolicy = base.cachePolicy;
  let sampling = base.sampling;
  for (const raw of value.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("≻")) continue;
    const divider = line.indexOf(":");
    if (divider === -1) return { error: `not key: value — "${line.slice(0, 40)}"` };
    const key = line.slice(0, divider).trim();
    const text = line.slice(divider + 1).trim();
    const scalarKnob = samplingScalarKnobForKey(key);
    const stringList = SAMPLING_STRING_LISTS.get(key);
    if (key === "provider") {
      if (!PROVIDER_VALUES.includes(text as Provider)) {
        return {
          error: `provider must be openai-compatible, text-completion, anthropic, or dry-run — "${text}"`
        };
      }
      next.provider = text as Provider;
    }
    else if (key === "baseUrl") next.baseUrl = text;
    else if (key === "allowInsecureHttp") {
      if (text !== "true" && text !== "false") {
        return { error: `allowInsecureHttp must be true or false — "${text}"` };
      }
      if (text === "true") next.allowInsecureHttp = true;
      else delete next.allowInsecureHttp;
    }
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
    } else if (scalarKnob !== null) {
      const parsed = text.length === 0 ? null : Number(text);
      if (parsed !== null && !Number.isFinite(parsed)) {
        return { error: `${key} is not a number or blank — "${text}"` };
      }
      if (parsed !== null) {
        try {
          validateSamplingScalar(scalarKnob, parsed, key);
        } catch (error) {
          return samplingParseError(error);
        }
      }
      sampling = { ...sampling, [scalarKnob]: parsed } as SamplingSettingsV2;
    } else if (stringList !== undefined) {
      const parsed = parseJsonValue(text, key, []);
      if (parsed.error !== undefined) return parsed;
      if (!Array.isArray(parsed.value) || parsed.value.some((item) => typeof item !== "string")) {
        return { error: `${key} must be a JSON array of strings` };
      }
      try {
        sampling = {
          ...sampling,
          [stringList.field]: stringList.validate(parsed.value, key)
        };
      } catch (error) {
        return samplingParseError(error);
      }
    } else if (key === "sampling.logitBias") {
      const parsed = parseJsonValue(text, key, {});
      if (parsed.error !== undefined) return parsed;
      if (parsed.value === null || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
        return { error: `${key} must be a JSON object` };
      }
      try {
        sampling = {
          ...sampling,
          logitBias: validateSamplingLogitBias(parsed.value, key)
        };
      } catch (error) {
        return samplingParseError(error);
      }
    } else if (key === "sampling.bannedStrings") {
      const parsed = parseJsonValue(text, key, []);
      if (parsed.error !== undefined) return parsed;
      if (!Array.isArray(parsed.value) || parsed.value.some((item) => typeof item !== "string")) {
        return { error: `${key} must be a JSON array of strings` };
      }
      try {
        sampling = {
          ...sampling,
          bannedStrings: validateSamplingBannedStrings(parsed.value, key)
        };
      } catch (error) {
        return samplingParseError(error);
      }
    } else if (key === "sampling.phraseBias") {
      const parsed = parseJsonValue(text, key, []);
      if (parsed.error !== undefined) return parsed;
      if (!Array.isArray(parsed.value)) {
        return { error: `${key} must be a JSON array of {phrase, weight} objects` };
      }
      try {
        sampling = {
          ...sampling,
          phraseBias: validateSamplingPhraseBias(parsed.value, key)
        };
      } catch (error) {
        return samplingParseError(error);
      }
    } else return { error: `unknown setting "${key}"` };
  }
  return { ...base, generation: next, cachePolicy, sampling };
}

function samplingScalarKnobForKey(key: string): SamplingScalarKnob | null {
  return SAMPLING_SCALAR_KEYS.has(key)
    ? key.slice("sampling.".length) as SamplingScalarKnob
    : null;
}

function samplingParseError(error: unknown): { error: string } {
  return { error: error instanceof Error ? error.message : String(error) };
}

function parseJsonValue(
  text: string,
  key: string,
  emptyValue: unknown
): { value: unknown; error?: never } | { error: string } {
  if (text.length === 0) return { value: emptyValue };
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { error: `${key} must contain valid JSON` };
  }
}
