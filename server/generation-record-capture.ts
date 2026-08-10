import type {
  GenerationRecordAdjustment,
  GenerationRecordEffectiveParameters,
  GenerationRecordField,
  GenerationRecordWireProtocol
} from "../shared/generation-record.js";

/**
 * The provider-layer capture side of Generation Records: what
 * server/providers.ts fills while a request runs, mirroring
 * server/token-probability-capture.ts's `TokenProbabilityCollector` pattern.
 *
 * Two seams, matching the architecture: a proactive strip made before the
 * first attempt because an earlier request already learned this model
 * refuses a field (`recordCachedRefusalSkip`) records nothing this request
 * itself decided; a mid-flight adjustment this request's own retry made
 * (`recordRetryAdjustment`) does. `finish` takes the final compact snapshot
 * of the wire body — never the whole body, only an allowlisted set of
 * sampling/shape fields that can never carry prompt content or a secret.
 */
export interface GenerationRecordCollector {
  effective: GenerationRecordEffectiveParameters | null;
}

/** Wire fields OpenAI Chat Completions requests can carry that are worth
 *  recording as "what this request actually asked for." Deliberately an
 *  allowlist, not "every key in the body": `messages` and `logit_bias`
 *  never belong in a compact effective-parameter summary, and a future body
 *  field is invisible here until named, never silently included. */
export const OPENAI_CHAT_EFFECTIVE_FIELDS = [
  "max_tokens", "max_completion_tokens", "temperature", "top_p", "top_k", "min_p",
  "frequency_penalty", "presence_penalty", "repeat_penalty", "seed",
  "dry_multiplier", "dry_base", "dry_penalty_last_n",
  "xtc_threshold", "xtc_probability", "dynatemp_range",
  "mirostat", "mirostat_mode", "mirostat_tau", "mirostat_eta",
  "reasoning_effort", "logprobs", "top_logprobs", "stream"
] as const;

export const ANTHROPIC_MESSAGES_EFFECTIVE_FIELDS = [
  "max_tokens", "temperature", "top_p", "top_k", "output_config.effort", "stream"
] as const;

export const TEXT_COMPLETION_EFFECTIVE_FIELDS = [
  "n_predict", "max_length", "max_tokens", "temperature",
  "top_p", "top_k", "min_p", "frequency_penalty", "presence_penalty",
  "repeat_penalty", "rep_pen", "seed", "sampler_seed",
  "dry_multiplier", "dry_base", "dry_penalty_last_n",
  "xtc_threshold", "xtc_probability", "dynatemp_range",
  "mirostat", "mirostat_mode", "mirostat_tau", "mirostat_eta", "stream"
] as const;

export function snapshotEffectiveFields(
  body: Record<string, unknown>,
  allowlist: readonly string[]
): GenerationRecordField[] {
  const fields: GenerationRecordField[] = [];
  for (const field of allowlist) {
    const value = effectiveFieldValue(body, field);
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      fields.push({ field, value });
    }
  }
  return fields;
}

function effectiveFieldValue(body: Record<string, unknown>, field: string): unknown {
  let value: unknown = body;
  for (const segment of field.split(".")) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

function hasEffectiveField(body: Record<string, unknown>, field: string): boolean {
  return effectiveFieldValue(body, field) !== undefined;
}

export interface GenerationRecordCapture {
  /** A field this request never sent because a prior request already learned
   *  this endpoint refuses it. Not an adjustment this request made. */
  recordCachedRefusalSkip(fields: readonly string[]): void;
  /** Diff the allowlisted fields before and after a successful retry
   *  adjustment, recording exactly which ones moved. Compares snapshots
   *  rather than asking the adjustment function to self-report, so a new
   *  adjustment case in server/providers.ts is captured automatically the
   *  moment it changes one of the allowlisted fields — nothing here has to
   *  be told about it by name. */
  recordRetryAdjustment(
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    attempt: number
  ): void;
  /** Take the final snapshot once a stream produced output worth committing —
   *  a clean completion, or a failure after some text already streamed (the
   *  body a stopped-partial commit will describe). Safe to call more than
   *  once; the last call wins, matching whichever attempt's body a caller
   *  ultimately keeps. */
  finish(body: Record<string, unknown>): void;
}

export function createGenerationRecordCapture(
  collector: GenerationRecordCollector | undefined,
  wireProtocol: GenerationRecordWireProtocol,
  allowlist: readonly string[]
): GenerationRecordCapture {
  const adjustments: GenerationRecordAdjustment[] = [];
  return {
    recordCachedRefusalSkip(fields: readonly string[]): void {
      if (collector === undefined) return;
      for (const field of fields) {
        adjustments.push({ stage: "construction", field, action: "skipped-cached-refusal" });
      }
    },
    recordRetryAdjustment(before, after, attempt): void {
      if (collector === undefined) return;
      for (const field of allowlist) {
        const had = hasEffectiveField(before, field);
        const has = hasEffectiveField(after, field);
        if (had && !has) adjustments.push({ stage: "retry", field, action: "dropped", attempt });
        else if (!had && has) adjustments.push({ stage: "retry", field, action: "added", attempt });
      }
    },
    finish(body): void {
      if (collector === undefined) return;
      collector.effective = {
        wireProtocol,
        fields: snapshotEffectiveFields(body, allowlist),
        adjustments: [...adjustments]
      };
    }
  };
}

/** Dry-run sends no wire body at all, so there is nothing to snapshot beyond
 *  the protocol tag itself — used directly by callers that skip the capture
 *  object above entirely. */
export function dryRunEffectiveParameters(): GenerationRecordEffectiveParameters {
  return { wireProtocol: "dry-run", fields: [], adjustments: [] };
}
