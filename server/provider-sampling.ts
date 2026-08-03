import {
  firstBlockingSamplingBiasEntry,
  isLogitBiasFamilyKnob,
  resolveConfiguredSamplingKnobs,
  samplingBiasEntryRejectionMessage,
  samplingBiasResolutionFailureMessage,
  samplingKnobLabel,
  samplingUnavailableReason,
  type SamplingContext
} from "../shared/sampling-capabilities.js";
import { maxResolvedLogitBiasEntries } from "../shared/sampling-validation-policy.js";
import {
  SAMPLING_SCALAR_KNOB_V2_VALUES,
  type SamplingKnobV2,
  type SamplingScalarKnobV2,
  type SamplingSettingsV2,
  type SettingsPresetV2
} from "../shared/settings-v2-types.js";
import type { GenerationSettings } from "../shared/types.js";
import { ProviderError } from "./errors.js";
import { providerRuntimeFor } from "./provider-runtime.js";
import { resolveSamplingBiasForSettings } from "./sampling-phrase-bias.js";

export async function applySamplingFields(
  body: Record<string, unknown>,
  settings: GenerationSettings,
  protocol: "openai-chat-completions" | "anthropic-messages",
  signal?: AbortSignal
): Promise<void> {
  const runtime = providerRuntimeFor(settings);
  const sampling = runtime.sampling;
  const context: SamplingContext = {
    protocol,
    preset: runtime.preset,
    remoteModelId: settings.model,
    temperatureSupport: runtime.capabilities.temperature
  };
  const configured = resolveConfiguredSamplingKnobs(context, sampling);
  for (const { knob, resolution } of configured) {
    if (resolution.kind === "unavailable") {
      throw new ProviderError(
        `Configured sampling parameter ${samplingKnobLabel(knob)} is unavailable: ${
          samplingUnavailableReason(resolution.reason)
        }`
      );
    }
  }
  const logitBiasFamilyMember = configured.find(({ knob }) => isLogitBiasFamilyKnob(knob));
  if (logitBiasFamilyMember !== undefined) {
    // Read the wire field off this knob's own resolution instead of
    // hardcoding "logit_bias" (issue #282 review round 5, finding 3): the
    // capability matrix is the single owner of wire spelling, including its
    // per-preset override hook (KoboldCpp spells mirostat as
    // mirostat_mode) — a hardcode here made that hook dead for the whole
    // bias family. logitBias, phraseBias and bannedStrings all resolve to
    // the same wireField (see the PROTOCOL_WIRE comment in
    // shared/sampling-capabilities.ts), so any one of them names the field
    // for the merged object. Every entry in `configured` is "available" by
    // this point — an "unavailable" one already threw in the loop above.
    const resolution = logitBiasFamilyMember.resolution;
    if (resolution.kind !== "available") {
      throw new Error(
        `Configured sampling parameter ${samplingKnobLabel(logitBiasFamilyMember.knob)} `
        + "reached encoding without an available resolution"
      );
    }
    body[resolution.wireField] = await mergedLogitBiasValue(sampling, settings, context.preset, signal);
  }
  for (const { knob, resolution } of configured) {
    if (resolution.kind !== "available") continue;
    if (isLogitBiasFamilyKnob(knob)) continue;
    body[resolution.wireField] = encodeSamplingValue(knob, sampling);
  }
}

const SAMPLING_SCALAR_KNOB_SET: ReadonlySet<SamplingKnobV2> = new Set(
  SAMPLING_SCALAR_KNOB_V2_VALUES
);

function isSamplingScalarKnob(knob: SamplingKnobV2): knob is SamplingScalarKnobV2 {
  return SAMPLING_SCALAR_KNOB_SET.has(knob);
}

/** Runs the shared tokenize-and-merge resolution (server/sampling-phrase-bias.ts)
 * and its preset-aware bound unconditionally — even when phraseBias and
 * bannedStrings are both empty, resolution just sorts the raw numeric map,
 * which still needs the same bound check: a raw logitBias map alone can
 * carry more entries than a preset (KoboldCpp) documents. There is one cap,
 * on one object, checked one way.
 *
 * Async because a llama-cpp route resolves phraseBias/bannedStrings by
 * asking that server to tokenize (server/context-probe.ts,
 * probeLlamaCppTokenize) rather than a local allow-list — the only reason
 * this function, and applySamplingFields above it, are not synchronous. */
async function mergedLogitBiasValue(
  sampling: SamplingSettingsV2,
  settings: GenerationSettings,
  preset: SettingsPresetV2 | "legacy-v1",
  signal: AbortSignal | undefined
): Promise<Readonly<Record<string, number>>> {
  const resolvedPreset = requirePreset(preset);
  const resolved = await resolveSamplingBiasForSettings(sampling, settings, signal);
  if (resolved.kind !== "resolved") {
    throw new ProviderError(`Could not resolve phrase bias or banned strings: ${samplingBiasResolutionFailureMessage(resolved)}.`);
  }
  const blocking = firstBlockingSamplingBiasEntry(resolved.phraseBias, resolved.bannedStrings);
  if (blocking !== undefined) {
    throw new ProviderError(
      `Could not use ${JSON.stringify(blocking.phrase)} as configured: ${samplingBiasEntryRejectionMessage(blocking)}.`
    );
  }
  const bound = maxResolvedLogitBiasEntries(resolvedPreset);
  if (resolved.resolvedEntryCount > bound) {
    throw new ProviderError(
      `Resolved logit bias has ${resolved.resolvedEntryCount} entries, `
      + `exceeding the ${bound}-entry limit for preset ${resolvedPreset}.`
    );
  }
  return sortedLogitBias(resolved.logitBias);
}

function requirePreset(preset: SettingsPresetV2 | "legacy-v1"): SettingsPresetV2 {
  if (preset === "legacy-v1") {
    throw new Error("Legacy v1 settings cannot reach sampling encoding");
  }
  return preset;
}

function sortedLogitBias(logitBias: Readonly<Record<string, number>>): Readonly<Record<string, number>> {
  return Object.fromEntries(
    Object.entries(logitBias).sort((left, right) => Number(left[0]) - Number(right[0]))
  );
}

function encodeSamplingValue(
  knob: Exclude<SamplingKnobV2, "logitBias" | "phraseBias" | "bannedStrings">,
  sampling: SamplingSettingsV2
): number | readonly string[] {
  if (isSamplingScalarKnob(knob)) return configuredScalarValue(sampling[knob], knob);
  switch (knob) {
    case "stop":
      return [...sampling.stop];
    case "dryBreakers":
      return [...sampling.dryBreakers];
    default:
      return assertNever(knob);
  }
}

function configuredScalarValue(
  value: number | null,
  knob: SamplingScalarKnobV2
): number {
  if (value === null) {
    throw new Error(`Configured sampling scalar ${samplingKnobLabel(knob)} is unexpectedly null`);
  }
  return value;
}

function assertNever(value: never): never {
  throw new Error(`Unsupported sampling parameter ${String(value)}`);
}
