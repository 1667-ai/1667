import {
  firstBlockedNativeBannedString,
  firstBlockingSamplingBiasEntry,
  isLogitBiasFamilyKnob,
  resolveConfiguredSamplingKnobs,
  resolveSamplingKnob,
  samplingBiasEntryRejectionMessage,
  samplingBiasNativeBlockedMessage,
  samplingBiasResolutionFailureMessage,
  samplingKnobLabel,
  samplingUnavailableReason,
  type ConfiguredSamplingKnob,
  type SamplingContext
} from "../shared/sampling-capabilities.js";
import {
  maxResolvedLogitBiasEntries,
  SAMPLING_NATIVE_BANNED_STRINGS_POLICY
} from "../shared/sampling-validation-policy.js";
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
    const merged = await mergedSamplingBiasValue(sampling, settings, context.preset, request);
    const logitBiasWireField = requireBiasFamilyWireField(context, sampling, "logitBias");
    body[logitBiasWireField] = merged.logitBias;
    // Only written when non-empty (issue #311): every preset but KoboldCpp
    // never populates this at all (`mergedSamplingBiasValue` only ever fills
    // it from `resolved.nativeBannedStrings` — see its own comment — and
    // that field is filled only by KoboldCpp's own transport), and even
    // there a route with only phraseBias or logitBias configured has
    // nothing to put in it. KoboldCpp's `banned_tokens` documents no
    // default, unlike `logit_bias` ("default": {}), so this skips sending an
    // empty array where the unconditional `logit_bias` write above sends a
    // documented-default empty object either way.
    if (merged.nativeBannedStrings.length > 0) {
      const bannedStringsWireField = requireBiasFamilyWireField(context, sampling, "bannedStrings");
      // Defense in depth alongside the type-level fix (issue #311 review,
      // second pass, finding A): `merged.nativeBannedStrings` should now be
      // reachable only when `context.preset` is "koboldcpp", the one preset
      // `PRESET_WIRE_OVERRIDES` gives its own `bannedStrings` field — but if
      // that ever stopped being true, falling back to `logitBiasWireField`
      // silently would overwrite the object just written above with an
      // array of literal strings. Asserting the two fields differ, instead
      // of trusting the fallback, turns that into a loud internal error
      // rather than a silently dropped logit bias.
      if (bannedStringsWireField === logitBiasWireField) {
        throw new Error(
          `sampling-bias native write would overwrite ${JSON.stringify(logitBiasWireField)} — `
          + `preset ${JSON.stringify(context.preset)} has no distinct bannedStrings wire field override`
        );
      }
      body[bannedStringsWireField] = merged.nativeBannedStrings;
    }
  }
  for (const { knob, resolution } of configured) {
    if (resolution.kind !== "available") continue;
    if (isLogitBiasFamilyKnob(knob)) continue;
    body[resolution.wireField] = encodeSamplingValue(knob, sampling);
  }
}

/** The wire field one logit-bias-family knob resolves to on this route,
 * looked up fresh rather than reused from `logitBiasFamily.resolution`
 * (issue #311): that resolution names whichever family member
 * `resolveLogitBiasFamilyKnob` happened to pick as the family's
 * representative, which is only ever safe to reuse for the *merged token
 * map*'s wire field when the representative is `logitBias` itself.
 * `logitBias` is deliberately what the merged-map write below asks for, not
 * `phraseBias`: `PRESET_SUBTRACTIONS` (shared/sampling-capabilities.ts)
 * subtracts `phraseBias`/`bannedStrings` without subtracting `logitBias` on
 * "custom" and "openrouter", and the tokenizer-trust gate in
 * `resolveSamplingKnob` can independently make `phraseBias`/`bannedStrings`
 * unavailable ("no-exact-tokenizer") while `logitBias` — a raw token ID,
 * needing no tokenizer at all — stays available. A route configuring only a
 * raw numeric `logitBias` map on one of those presets used to reach here
 * with `phraseBias` picked as the representative and throw on an otherwise
 * valid request (issue #311 review: caught by the existing "OpenAI-compatible
 * serializers lower the documented baseline and preset extensions" test).
 * `logitBias` has no such gap the other direction: nothing subtracts it
 * while leaving `phraseBias` or `bannedStrings` available, so it is always
 * the safe choice for the merged map's own field.
 *
 * The `bannedStrings` write below still asks for its own field explicitly,
 * never `logitBias`'s: that is the one member whose wire field can
 * genuinely diverge (`banned_tokens` on KoboldCpp, PRESET_WIRE_OVERRIDES),
 * and a route reaches that write only when `merged.nativeBannedStrings` is
 * non-empty, which — see `resolveSamplingLogitBias`'s "native" transport,
 * server/sampling-phrase-bias.ts — is only ever true when `bannedStrings`
 * itself resolved availably on KoboldCpp. */
function requireBiasFamilyWireField(
  context: SamplingContext,
  sampling: SamplingSettingsV2,
  knob: "logitBias" | "bannedStrings"
): string {
  const resolution = resolveSamplingKnob(context, sampling, knob);
  if (resolution.kind !== "available") {
    throw new Error(`sampling-bias wire field requested for an unavailable ${samplingKnobLabel(knob)} route`);
  }
  return resolution.wireField;
}

/** The one knob that names this request's logit-bias-family availability
 * (issue #282 review round 5, finding 3; issue #341 finding 4) — its
 * `.resolution.wireField` is not read by any caller (issue #311 moved that
 * to `requireBiasFamilyWireField` above, once KoboldCpp's bannedStrings
 * started resolving to its own field instead of always agreeing with
 * phraseBias/logitBias); this function answers only "is the family
 * configured at all, and can this route use it". An earlier version
 * answered this in two separate branches — a profile member's own
 * already-resolved entry when the profile configured one, a fresh
 * `resolveSamplingKnob(..., "phraseBias")` call when only a story did —
 * ending in the identical error construction reached two ways, with a
 * `storyHasBias` boolean whose only job was picking a branch. Both branches
 * were answering the same question, so this answers it once: a profile
 * member if `configured` (built from the profile alone) already named
 * one — reading `configured` in `SAMPLING_KNOB_V2_VALUES` order, so
 * `logitBias` (listed first) wins the pick whenever the profile configured
 * it alongside phraseBias/bannedStrings — and otherwise, only when a story
 * contributes phraseBias or bannedStrings the profile has nothing of its
 * own in the family (issue #341 decision 3: a story value adds to the
 * profile's, even when the profile's own contribution is empty),
 * "phraseBias" standing in for the family.
 *
 * "phraseBias" is a safe stand-in specifically for that story-only branch
 * (issue #311 re-derived this, since it is no longer trivially true of the
 * whole family): phraseBias and bannedStrings always share the identical
 * availability outcome as each other — every PRESET_SUBTRACTIONS entry
 * lists them together, never one without the other, and the tokenizer-trust
 * gate in resolveSamplingKnob applies to both identically — so asking for
 * either one's availability here answers the same question a story-only
 * bannedStrings value would need answered too. `logitBias` is not
 * interchangeable with the other two the same way: "custom" and
 * "openrouter" subtract phraseBias/bannedStrings while leaving logitBias
 * available (shared/sampling-capabilities.ts, PRESET_SUBTRACTIONS), so
 * `logitBias`'s own availability is always at least as permissive as
 * phraseBias/bannedStrings', never less — which is exactly the asymmetry
 * `requireBiasFamilyWireField` above relies on to resolve the merged map's
 * wire field safely off `logitBias` specifically. Returns `undefined` when
 * neither scope has anything in the family configured — there is nothing to
 * check or apply. */
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

/** What one route's sampling bias resolves to on the wire: the merged
 * token-ID map every preset sends under its logit-bias field, plus — issue
 * #311, KoboldCpp only — the literal banned-string texts
 * `resolved.nativeBannedStrings` carries (server/sampling-phrase-bias.ts,
 * `resolveSamplingLogitBias`'s "native" transport), sent verbatim to
 * KoboldCpp's own `banned_tokens` field instead of being tokenized into
 * `logitBias`. Empty on every other preset: `nativeBannedStrings` is filled
 * only by that one transport, itself reachable only on KoboldCpp
 * (`bannedStringsTransportForPreset`, shared/sampling-phrase-resolution.ts)
 * — a native `bannedStrings` entry on any other preset is not a runtime
 * state this field can even represent, let alone reach the wire under the
 * wrong field name (issue #311 review, second pass, finding A). */
interface MergedSamplingBiasValue {
  readonly logitBias: Readonly<Record<string, number>>;
  readonly nativeBannedStrings: readonly string[];
}

/** Runs the shared tokenize-and-merge resolution (server/sampling-phrase-bias.ts)
 * and its preset-aware bound unconditionally — even when phraseBias and
 * bannedStrings are both empty, resolution just sorts the raw numeric map,
 * which still needs the same bound check: a raw logitBias map alone can
 * carry more entries than a preset (KoboldCpp) documents. There is one cap,
 * on one object, checked one way — and it binds only `logitBias`: KoboldCpp's
 * documented 16-entry cap is on its `logit_bias` dictionary specifically
 * (shared/sampling-validation-policy.ts), not on `banned_tokens`. A native
 * banned string carries no count of its own against *that* cap — but it has
 * its own, separate one, `SAMPLING_NATIVE_BANNED_STRINGS_POLICY`, checked
 * below (issue #311 review, second pass, "not required" item: profile and
 * story bannedStrings, deduplicated, are otherwise bounded only by their two
 * independent 256-entry per-scope caps).
 *
 * Also refuses a "blocked" native bannedStrings entry — a same-scope
 * contradiction with a phraseBias phrase (issue #311, second pass, finding
 * B) — the same way `firstBlockingSamplingBiasEntry` above refuses a
 * "rejected" or "shadowed" one; see `firstBlockedNativeBannedString`'s own
 * comment for why it cannot be the same list.
 *
 * Async because a llama-cpp or KoboldCpp route resolves phraseBias by asking
 * that server to tokenize (server/context-probe.ts, probeLlamaCppTokenize /
 * probeKoboldCppTokenize) rather than a local allow-list — the only reason
 * this function, and applySamplingFields above it, are not synchronous. */
async function mergedSamplingBiasValue(
  sampling: SamplingSettingsV2,
  settings: GenerationSettings,
  preset: SettingsPresetV2 | "legacy-v1",
  request: StorySamplingRequest
): Promise<MergedSamplingBiasValue> {
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
  const blockedNative = firstBlockedNativeBannedString(resolved.nativeBannedStrings);
  if (blockedNative !== undefined) {
    throw new ProviderError(
      `Could not use ${JSON.stringify(blockedNative.phrase)} as configured: `
      + `${samplingBiasNativeBlockedMessage(blockedNative)}.`
    );
  }
  const bound = maxResolvedLogitBiasEntries(resolvedPreset);
  if (resolved.resolvedEntryCount > bound) {
    throw new ProviderError(
      `Resolved logit bias has ${resolved.resolvedEntryCount} entries, `
      + `exceeding the ${bound}-entry limit for preset ${resolvedPreset}.`
    );
  }
  // Every "blocked" native entry was already refused above (a plain read,
  // issue #311 review, second pass, finding F2, rather than the per-source
  // ternary this used to be when a native entry rode `resolved.bannedStrings`
  // alongside every other kind that list can hold) — but "overridden" is
  // not: it is non-blocking, and a losing native banned string must not
  // reach `banned_tokens` at all, the same way a losing phraseBias entry's
  // own weight never reaches `logit_bias` (issue #311 review, third pass,
  // finding G — server/sampling-phrase-bias.ts already excludes it from
  // `logitBias`; this is that same exclusion for the other wire field).
  const nativeBannedStrings = [...new Set(
    resolved.nativeBannedStrings.flatMap((entry) => entry.kind === "native" ? [entry.phrase] : [])
  )];
  if (nativeBannedStrings.length > SAMPLING_NATIVE_BANNED_STRINGS_POLICY.maxEntries) {
    throw new ProviderError(
      `Resolved banned strings has ${nativeBannedStrings.length} entries, exceeding the `
      + `${SAMPLING_NATIVE_BANNED_STRINGS_POLICY.maxEntries}-entry limit.`
    );
  }
  return { logitBias: sortedLogitBias(resolved.logitBias), nativeBannedStrings };
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
