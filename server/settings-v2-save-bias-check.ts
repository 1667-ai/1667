import {
  SETTINGS_ROUTE_PURPOSE_VALUES,
  type SettingsDocumentV2
} from "../shared/settings-v2-types.js";
import { selectSettingsRoute } from "../shared/settings-route.js";
import type { GenerationSettings } from "../shared/types.js";
import { ProviderError } from "./errors.js";
import { effectiveGenerationRuntime } from "./settings-v2-conversion.js";
import { invalidSettingsMutation } from "./settings-v2-mutation.js";
import { resolveSamplingBiasForSettings } from "./sampling-phrase-bias.js";
import { validateSamplingRoute } from "./settings-v2-sampling-validation.js";

/** How long the whole live-tokenize-probe bias-resolution phase of a save
 * gets, across every routed profile combined (see
 * `assertSavedSamplingBiasResolves` below) — issue #282 review round 3,
 * finding 3. The check is fail-open, so this only needs to be long enough
 * for a live, reachable server to answer a handful of small tokenize POSTs;
 * it does not need to approach the 30-second save budget
 * (`shared/http-operation-protocol.ts`, `HTTP_OPERATION_LIFETIME_MS.local`),
 * because waiting longer can never change a fail-open outcome, only delay
 * it. */
export const SAMPLING_BIAS_SAVE_PROBE_DEADLINE_MS = 5_000;

/**
 * Closes the live-tokenize-probe save-time hole issue #282 review round 2
 * flagged (finding 6), which issue #311 extended from llama-cpp to
 * KoboldCpp: `validateSamplingRoute` cannot resolve phraseBias for a
 * live-tokenize preset without reaching its server, and it must stay
 * synchronous for every other caller — document decode runs far more often
 * than a save and must never make a network call. The save path is async
 * already, so it is the one place that can afford to actually ask, and it
 * is the only caller that supplies `validateSamplingRoute` a real,
 * network-resolved `precomputedResolution`.
 *
 * Bounded to the routed purposes (default/prose/utility, deduplicated —
 * the same three `assertRuntimeDocumentSupported` the caller runs first
 * already resolves): an unrouted profile cannot reach generation yet, so
 * there is nothing to protect by resolving it here too. A route this save
 * cannot itself build a runtime for is skipped, not failed —
 * `assertRuntimeDocumentSupported` already rejects the save for that.
 *
 * `SAMPLING_BIAS_SAVE_PROBE_DEADLINE_MS` bounds this whole loop, not each
 * profile in it, and `signal` (the caller's own, threaded from the HTTP
 * request) is folded into the same deadline (issue #282 review round 3,
 * finding 3): up to three distinct routed profiles can each reach a
 * different llama.cpp or KoboldCpp server, and each one that does can still
 * fire several tokenize POSTs against it — one per distinct surface-variant
 * text (server/sampling-phrase-bias.ts, liveProbeVariantTokenizer) — so the
 * prior per-request timeout alone let a single blackholed host (asleep, VPN
 * dropped, stale address — not a refused connection, which fails fast)
 * consume the whole 30-second save budget three times over. This check is
 * fail-open — an unresolved profile just skips its own bias validation,
 * below — so a shorter deadline or an earlier abort cannot change the
 * verdict, only reach the same verdict sooner: there is nothing this budget
 * protects by running longer.
 *
 * `environment` is the store's own resolved `NodeJS.ProcessEnv` snapshot,
 * passed through rather than read from `process.env` here, so this check
 * resolves credentials exactly like the rest of the save path does.
 */
export async function assertSavedSamplingBiasResolves(
  document: SettingsDocumentV2,
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal
): Promise<void> {
  const deadline = AbortSignal.timeout(SAMPLING_BIAS_SAVE_PROBE_DEADLINE_MS);
  const probeSignal = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
  const resolvedProfileIds = new Set<string>();
  for (const purpose of SETTINGS_ROUTE_PURPOSE_VALUES) {
    const route = selectSettingsRoute(document, purpose);
    if (route.profile.sampling === undefined || resolvedProfileIds.has(route.profileId)) continue;
    resolvedProfileIds.add(route.profileId);
    let settings: GenerationSettings;
    try {
      settings = effectiveGenerationRuntime(document, purpose, {}, environment).settings;
    } catch {
      continue;
    }
    let resolution: Awaited<ReturnType<typeof resolveSamplingBiasForSettings>>;
    try {
      resolution = await resolveSamplingBiasForSettings(route.profile.sampling, settings, { signal: probeSignal });
    } catch (error) {
      // The probe itself did not answer in time — the shared deadline
      // above, the caller's own abort, or an ordinary provider/network
      // failure. Fail open, exactly like a clean "tokenizer-unavailable"
      // result: this check must never block a save on an unreachable
      // llama.cpp server, and once the deadline is shared across every
      // remaining profile in this loop, none of them can answer either.
      //
      // Narrowed to exactly those cases (issue #282 review round 4,
      // finding 5): a bare `catch { continue }` here also swallowed two
      // deliberate invariant throws inside the resolver —
      // `neverCalledTokenizer` and the "tokenize probe never queued"
      // guard (server/sampling-phrase-bias.ts) — whose own comments say
      // throwing exists to surface a real bug immediately. Swallowed on
      // this save-time path, that bug would only resurface later, as a
      // generation failure instead of a save failure.
      if (!isFailOpenSamplingProbeError(error, probeSignal)) throw error;
      continue;
    }
    try {
      validateSamplingRoute(route.profileId, route.profile, route.model, route.connection, resolution);
    } catch (error) {
      // A rejected/shadowed entry or an over-cap resolved count throws a
      // plain SettingsFormatError, the same as every other save-time
      // validation failure in server/settings-v2-store.ts — wrap it the
      // same way (server/settings-v2-mutation.ts, invalidSettingsMutation)
      // so it reaches the writer as its own 400 message instead of falling
      // through to a generic "Internal server error" at the transport's
      // classifyServiceError boundary (server/service-error-policy.ts),
      // which only recognizes ServiceError and a short allow-list of
      // other known types.
      throw invalidSettingsMutation(error);
    }
  }
}

/** Whether `error` is one of the two reasons `assertSavedSamplingBiasResolves`
 * is allowed to fail open on: `signal` (the shared save-probe deadline,
 * joined with the caller's own abort via `AbortSignal.any`) firing, or an
 * ordinary `ProviderError` from the provider transport. Anything else —
 * notably an invariant throw from inside the resolver itself — must
 * propagate instead of being silently treated as "server unreachable"
 * (issue #282 review round 4, finding 5). */
function isFailOpenSamplingProbeError(error: unknown, signal: AbortSignal): boolean {
  if (error instanceof ProviderError) return true;
  if (!(error instanceof Error)) return false;
  return signal.aborted
    && (error === signal.reason || error.name === "AbortError" || error.name === "TimeoutError");
}
