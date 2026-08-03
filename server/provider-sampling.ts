import {
  firstBlockingSamplingBiasEntry,
  isLogitBiasFamilyKnob,
  resolveConfiguredSamplingKnobs,
  resolveSamplingKnob,
  samplingBiasEntryRejectionMessage,
  samplingBiasResolutionFailureMessage,
  samplingKnobLabel,
  samplingUnavailableReason,
  type ConfiguredSamplingKnob,
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
import {
  resolveSamplingBiasForSettings,
  type StorySamplingBias,
  type StorySamplingRequest
} from "./sampling-phrase-bias.js";

export async function applySamplingFields(
  body: Record<string, unknown>,
  settings: GenerationSettings,
  protocol: "openai-chat-completions" | "anthropic-messages",
  request: StorySamplingRequest = {}
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
  const logitBiasFamily = resolveLogitBiasFamilyKnob(context, sampling, configured, request.storySampling);
  if (logitBiasFamily !== undefined) {
    if (logitBiasFamily.resolution.kind !== "available") {
      throw new ProviderError(
        `Configured sampling parameter ${samplingKnobLabel(logitBiasFamily.knob)} is unavailable: ${
          samplingUnavailableReason(logitBiasFamily.resolution.reason)
        }`
      );
    }
    body[logitBiasFamily.resolution.wireField] =
      await mergedLogitBiasValue(sampling, settings, context.preset, request);
  }
  for (const { knob, resolution } of configured) {
    if (resolution.kind !== "available") continue;
    if (isLogitBiasFamilyKnob(knob)) continue;
    body[resolution.wireField] = encodeSamplingValue(knob, sampling);
  }
}

/** The one knob that names this request's logit-bias-family wire field and
 * availability (issue #282 review round 5, finding 3; issue #341 finding 4).
 * An earlier version answered this in two separate branches — a profile
 * member's own already-resolved entry when the profile configured one, a
 * fresh `resolveSamplingKnob(..., "phraseBias")` call when only a story did —
 * ending in the identical error construction and assignment reached two
 * ways, with a `storyHasBias` boolean whose only job was picking a branch.
 * Both branches were answering the same question, so this answers it once:
 * a profile member if `configured` (built from the profile alone) already
 * named one — reading the wire field off whichever member the profile
 * configured, never hardcoding "logit_bias", is what keeps a per-preset wire
 * override (KoboldCpp spells mirostat as mirostat_mode) live for the whole
 * family — and otherwise, only when a story contributes phraseBias or
 * bannedStrings the profile has nothing of its own in the family (issue #341
 * decision 3: a story value adds to the profile's, even when the profile's
 * own contribution is empty), "phraseBias" standing in for the family
 * because logitBias, phraseBias and bannedStrings always resolve to the
 * identical wire field and availability reason on one route (the
 * PROTOCOL_WIRE comment in shared/sampling-capabilities.ts). Returns
 * `undefined` when neither scope has anything in the family configured —
 * there is nothing to check or apply. */
function resolveLogitBiasFamilyKnob(
  context: SamplingContext,
  sampling: SamplingSettingsV2,
  configured: readonly ConfiguredSamplingKnob[],
  storySampling: StorySamplingBias | undefined
): ConfiguredSamplingKnob | undefined {
  const profileMember = configured.find(({ knob }) => isLogitBiasFamilyKnob(knob));
  if (profileMember !== undefined) return profileMember;
  const storyHasBias = storySampling !== undefined
    && (storySampling.phraseBias.length > 0 || storySampling.bannedStrings.length > 0);
  if (!storyHasBias) return undefined;
  return { knob: "phraseBias", resolution: resolveSamplingKnob(context, sampling, "phraseBias") };
}

/** Whether the profile's or a story's own logit-bias-family value
 * (phraseBias, bannedStrings, or the raw numeric logitBias map) is
 * configured at all, and, if so, whether this route can use it — the same
 * question `applySamplingFields` answers via `resolveLogitBiasFamilyKnob`
 * above before building a real request body, extracted so a route with no
 * request body to build at all can still refuse the same way (issue #341
 * finding 2b). The dry-run route is exactly that: `streamCompletion`'s
 * dry-run branch never calls `applySamplingFields` at all, because it never
 * builds a request body, so a story's phrase bias used to generate
 * successfully through it while the editor's own preview already reported
 * the knob unavailable (dry-run supports no sampling knob at all — see the
 * "dry-run" branch of `resolveSamplingKnob`). Resolves cleanly, doing
 * nothing, when neither scope has anything in the family configured — dry
 * run must keep working with nothing configured, exactly as it always has;
 * this only closes the gap for the one family whose availability the editor
 * can actually report. */
export function requireLogitBiasFamilyAvailable(
  settings: GenerationSettings,
  protocol: "openai-chat-completions" | "anthropic-messages" | "dry-run",
  storySampling?: StorySamplingBias
): void {
  const runtime = providerRuntimeFor(settings);
  const sampling = runtime.sampling;
  const context: SamplingContext = {
    protocol,
    preset: runtime.preset,
    remoteModelId: settings.model,
    temperatureSupport: runtime.capabilities.temperature
  };
  const configured = resolveConfiguredSamplingKnobs(context, sampling);
  const family = resolveLogitBiasFamilyKnob(context, sampling, configured, storySampling);
  if (family !== undefined && family.resolution.kind !== "available") {
    throw new ProviderError(
      `Configured sampling parameter ${samplingKnobLabel(family.knob)} is unavailable: ${
        samplingUnavailableReason(family.resolution.reason)
      }`
    );
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
  request: StorySamplingRequest
): Promise<Readonly<Record<string, number>>> {
  const resolvedPreset = requirePreset(preset);
  const resolved = await resolveSamplingBiasForSettings(sampling, settings, request);
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
