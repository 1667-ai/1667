import { parseJsonRejectingDuplicateKeys } from "./strict-json.js";
import { hasUnpairedSurrogate } from "../shared/unicode.js";
import type { ProfileTransferCandidate } from "../shared/generation-profile-transfer.js";

type MutableSampling = { -readonly [Key in keyof NonNullable<ProfileTransferCandidate["sampling"]>]?: NonNullable<ProfileTransferCandidate["sampling"]>[Key] };

export const MAX_SAMPLER_PRESET_BYTES = 64 * 1024;

/** Decode a NovelAI Sampler Preset without importing foreign token identifiers. */
export function importNovelAiSamplerPreset(text: string): ProfileTransferCandidate {
  if (Buffer.byteLength(text) > MAX_SAMPLER_PRESET_BYTES) throw new Error("Sampler Preset is larger than the 64KB import limit");
  const raw = record(parseJsonRejectingDuplicateKeys(text, "NovelAI Sampler Preset", { maxValues: 4_096 }));
  return importNovelAiSamplerPresetRecord(raw);
}

/** Decode a strict-JSON Sampler Preset object without importing foreign token identifiers. */
export function importNovelAiSamplerPresetRecord(raw: Record<string, unknown>): ProfileTransferCandidate {
  if (typeof raw.presetVersion !== "number") throw new Error("file is not a NovelAI Sampler Preset or Profile Export");
  const name = normalizedProfileName(string(raw.name));
  const parameters = raw.parameters === undefined ? {} : record(raw.parameters);
  const enabled = enabledOrder(parameters.order);
  const sampling: MutableSampling = {};
  const fidelity: string[] = [];
  let omittedCount = 0;
  for (const samplerId of enabled.unknownNumericIds) {
    omittedCount += 1;
    fidelity.push(`Sampler Preset sampler ID ${samplerId} not imported; it is unknown`);
  }
  if (enabled.activeRecognizedSamplerCount >= 2) {
    omittedCount += 1;
    fidelity.push("sampler order not imported; target order applies");
  }
  const mapping: ReadonlyArray<readonly [string, "topP" | "topK" | "minP" | "frequencyPenalty" | "presencePenalty"]> = [
    ["top_p", "topP"], ["top_k", "topK"], ["min_p", "minP"],
    ["repetition_penalty_frequency", "frequencyPenalty"],
    ["repetition_penalty_presence", "presencePenalty"]
  ];
  for (const [source, target] of mapping) {
    if (!isEnabled(enabled, source)) { fidelity.push(`${source.replaceAll("_", " ")} disabled in the Sampler Preset skipped`); continue; }
    const value = number(parameters[source]);
    if (value === null) {
      if (parameters[source] !== undefined) {
        omittedCount += 1;
        fidelity.push(`${source.replaceAll("_", " ")} not imported; it is not a finite number`);
      }
      continue;
    }
    if (source === "top_k" && value === 0) continue;
    setMappedSamplingValue(sampling, target, value);
  }
  let temperature: number | null | undefined;
  if (isEnabled(enabled, "temperature")) {
    const value = number(parameters.temperature);
    if (value !== null) temperature = value;
    else if (parameters.temperature !== undefined) {
      omittedCount += 1;
      fidelity.push("temperature not imported; it is not a finite number");
    }
  } else {
    temperature = null;
    fidelity.push("temperature disabled in the Sampler Preset skipped");
  }
  if (isEnabled(enabled, "mirostat")) {
    const tau = number(parameters.mirostat_tau);
    const eta = number(parameters.mirostat_lr);
    if (tau !== null && tau > 0) {
      sampling.mirostat = 2;
      sampling.mirostatTau = tau;
      if (eta !== null) sampling.mirostatEta = eta;
      else if (parameters.mirostat_lr !== undefined) {
        omittedCount += 1;
        fidelity.push("mirostat learning rate not imported; it is not a finite number");
      }
      fidelity.push("mirostat imported as version 2; NovelAI does not record a version");
    } else if (parameters.mirostat !== undefined || parameters.mirostat_tau !== undefined) {
      omittedCount += ["mirostat", "mirostat_tau", "mirostat_lr"]
        .filter((parameter) => parameters[parameter] !== undefined).length;
      fidelity.push("mirostat not imported; its target value is not a positive finite number");
    }
  }
  countUnsupported("repetition_penalty", "NovelAI uses a different penalty transform");
  for (const parameter of [
    "repetition_penalty_range", "repetition_penalty_slope", "repetition_penalty_whitelist",
    "repetition_penalty_default_whitelist"
  ]) {
    countUnsupported(parameter, "repetition penalty parameters apply to the whole request", "repetition_penalty");
  }
  for (const [parameter, sampler] of [
    ["top_a", "top_a"], ["typical_p", "typical_p"], ["tail_free_sampling", "tfs"],
    ["top_g", "top_g"], ["math1_temp", "math1"], ["math1_quad", "math1"],
    ["math1_quad_entropy_scale", "math1"], ["cfg_scale", "cfg"], ["cfg_uc", "cfg"],
    ["min_length", undefined]
  ] as const) {
    countUnsupported(parameter, "has no equivalent in Generation Profiles", sampler);
  }
  if (parameters.phrase_rep_pen !== "off") {
    countUnsupported("phrase_rep_pen", "has no equivalent in Generation Profiles", "phrase_rep_pen");
  }
  const tokenIds = ["stop_sequences", "bad_words_ids", "logit_bias_exp", "logit_bias_groups"]
    .filter((parameter) => parameterHasBehavior(parameters[parameter]))
    .sort();
  if (tokenIds.length > 0) {
    omittedCount += tokenIds.length;
    fidelity.push(`${tokenIds.length} NovelAI token-ID parameters not imported for another model vocabulary: ${tokenIds.map((key) => JSON.stringify(key)).join(", ")}`);
  }
  const knownParameters = new Set([
    "order", "temperature", "top_p", "top_k", "min_p",
    "repetition_penalty_frequency", "repetition_penalty_presence", "mirostat", "mirostat_tau", "mirostat_lr",
    "repetition_penalty", "repetition_penalty_range", "repetition_penalty_slope",
    "repetition_penalty_whitelist", "repetition_penalty_default_whitelist",
    "top_a", "typical_p", "tail_free_sampling", "top_g", "math1_temp", "math1_quad",
    "math1_quad_entropy_scale", "cfg_scale", "cfg_uc", "phrase_rep_pen", "min_length",
    "stop_sequences", "bad_words_ids", "logit_bias_exp", "logit_bias_groups", "max_length",
    "textGenerationSettingsVersion"
  ]);
  for (const parameter of Object.keys(parameters).filter((key) => !knownParameters.has(key)).sort()) {
    omittedCount += 1;
    fidelity.push(`Sampler Preset parameter ${JSON.stringify(parameter)} not imported; no equivalent exists`);
  }
  const maxOutputTokens = number(parameters.max_length) ?? undefined;
  if (parameters.max_length !== undefined && maxOutputTokens === undefined) {
    omittedCount += 1;
    fidelity.push("maximum output not imported; it is not a finite number");
  }
  return { name, ...(temperature === undefined ? {} : { temperature }), ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }), sampling, omittedCount, fidelity };

  function countUnsupported(parameter: string, description: string, sampler = parameter): void {
    if (parameters[parameter] === undefined || !isEnabled(enabled, sampler)) return;
    omittedCount += 1;
    fidelity.push(`${parameter.replaceAll("_", " ")} not imported; ${description}`);
  }
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Sampler Preset has an invalid object");
  return value as Record<string, unknown>;
}
function string(value: unknown): string | null { return typeof value === "string" ? value : null; }
function number(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }

function normalizedProfileName(value: string | null): string {
  if (value === null || hasUnpairedSurrogate(value)) return "Imported Sampler Preset";
  const trimmed = value.trim();
  if (trimmed.length === 0) return "Imported Sampler Preset";
  return [...trimmed].slice(0, 256).join("");
}

function parameterHasBehavior(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && typeof value === "object"
    ? Object.keys(value).length > 0
    : value !== undefined && value !== null;
}

function setMappedSamplingValue(
  sampling: MutableSampling,
  target: "topP" | "topK" | "minP" | "frequencyPenalty" | "presencePenalty",
  value: number
): void {
  sampling[target] = value;
}

// NovelAI's historical numeric `parameters.order` format removes disabled
// samplers from the array. The numeric IDs come from the public preset-format
// `Order` enum: https://aedial.github.io/novelai-api/novelai_api/novelai_api.Preset.html
const NUMERIC_SAMPLER_ORDER_IDS: ReadonlyMap<number, string> = new Map([
  [0, "temperature"], [1, "top_k"], [2, "top_p"], [3, "tfs"], [4, "top_a"],
  [5, "typical_p"], [6, "cfg"], [7, "top_g"], [8, "mirostat"], [9, "math1"], [10, "min_p"]
]);
const NUMERIC_SAMPLER_ORDER_NAMES: ReadonlySet<string> = new Set(NUMERIC_SAMPLER_ORDER_IDS.values());

interface SamplerOrder {
  readonly enabled: ReadonlyMap<string, boolean>;
  readonly numeric: boolean;
  readonly unknownNumericIds: readonly number[];
  readonly activeRecognizedSamplerCount: number;
}

function enabledOrder(value: unknown): SamplerOrder {
  if (value === undefined) {
    return { enabled: new Map(), numeric: false, unknownNumericIds: [], activeRecognizedSamplerCount: 0 };
  }
  if (!Array.isArray(value)) throw new Error("Sampler Preset has an invalid order");
  if (value.every((item) => typeof item === "number" && Number.isInteger(item))) {
    const enabled = new Map<string, boolean>();
    const unknownNumericIds: number[] = [];
    for (const samplerId of value) {
      const sampler = NUMERIC_SAMPLER_ORDER_IDS.get(samplerId);
      if (sampler === undefined) {
        if (!unknownNumericIds.includes(samplerId)) unknownNumericIds.push(samplerId);
      } else {
        enabled.set(sampler, true);
      }
    }
    return {
      enabled,
      numeric: true,
      unknownNumericIds,
      activeRecognizedSamplerCount: enabled.size
    };
  }
  if (!value.every(isObjectSamplerOrderEntry)) throw new Error("Sampler Preset has an invalid order");
  const enabled = new Map(value.map((entry) => [entry.id, entry.enabled] as const));
  return {
    enabled,
    numeric: false,
    unknownNumericIds: [],
    activeRecognizedSamplerCount: [...enabled].filter(
      ([sampler, isActive]) => isActive && NUMERIC_SAMPLER_ORDER_NAMES.has(sampler)
    ).length
  };
}

function isObjectSamplerOrderEntry(value: unknown): value is { readonly id: string; readonly enabled: boolean } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.id === "string" && typeof entry.enabled === "boolean";
}

function isEnabled(order: SamplerOrder, id: string): boolean {
  if (order.numeric && NUMERIC_SAMPLER_ORDER_NAMES.has(id)) {
    return order.enabled.has(id);
  }
  return order.enabled.get(id) !== false;
}
