import {
  promptBiasTokenizerEncoding,
  type PromptBiasEncoding
} from "../../shared/sampling-capabilities.js";
import type { ActionContext } from "./action-context.js";
import type { AppSource } from "./app.js";
import { samplingContextForOverlay } from "./sampling-model.js";
import type { SettingsOverlayState } from "./state.js";

/** One row's resolved-token display state, looked up by phrase text from
 * the whole-panel resolveSamplingBias result cached on the nested overlay
 * (tui/src/state.ts, SamplingBiasResolutionState). "phrase-unencodable"
 * names the one phrase that failed; every other row in the same batch is
 * "idle" (not "unavailable") because it is not implicated. */
export type SamplingBiasRowResolution =
  | { readonly kind: "idle" }
  | { readonly kind: "pending" }
  | { readonly kind: "tokenizer-unavailable" }
  | { readonly kind: "phrase-unencodable" }
  | { readonly kind: "resolved"; readonly tokenIds: readonly number[] };

/** The encoding the routed model would use, or null when there is no exact
 * tokenizer to resolve against (the presentation layer already explains why,
 * through samplingKnobPresentation's "no-exact-tokenizer" reason). */
export function samplingEncodingForOverlay(overlay: SettingsOverlayState): PromptBiasEncoding | null {
  if (!overlay.view.editable) return null;
  const context = samplingContextForOverlay(overlay);
  if (context.protocol !== "openai-chat-completions") return null;
  return promptBiasTokenizerEncoding(context.remoteModelId);
}

export function samplingBiasRowResolution(
  overlay: SettingsOverlayState,
  list: "phraseBias" | "bannedStrings",
  phrase: string
): SamplingBiasRowResolution {
  const nested = overlay.sampling;
  if (nested === null) return { kind: "idle" };
  const state = nested.biasResolution;
  if (state.kind === "idle" || state.kind === "pending") return state;
  const result = state.result;
  if (result.kind === "tokenizer-unavailable") return { kind: "tokenizer-unavailable" };
  if (result.kind === "phrase-unencodable") {
    return result.phrase === phrase ? { kind: "phrase-unencodable" } : { kind: "idle" };
  }
  const entry = (list === "phraseBias" ? result.phraseBias : result.bannedStrings)
    .find((item) => item.phrase === phrase);
  return entry === undefined ? { kind: "idle" } : { kind: "resolved", tokenIds: entry.tokenIds };
}

/**
 * Fetches resolveSamplingBias for the current draft's phraseBias and
 * bannedStrings together — one call, not one per phrase (issue #282 review,
 * finding E): a phrase-bias panel with 60 entries used to fire 60 worker
 * round trips just to open. Call this when the sampling editor opens and
 * again after each list-panel edit commits.
 *
 * Uses `backend.observe`, not `backend.run`: ActionRunner.run is single
 * -flight (tui/src/action-runtime.ts) and would reject a concurrent
 * resolution with a "busy" toast, or contend with whatever the writer does
 * next. `observe` surfaces only genuine failures, without claiming that slot.
 */
export function resolveSamplingBias(
  overlay: SettingsOverlayState,
  source: AppSource,
  context: ActionContext
): void {
  const nested = overlay.sampling;
  if (nested === null) return;
  const encoding = samplingEncodingForOverlay(overlay);
  if (encoding === null) {
    nested.biasResolution = { kind: "idle" };
    return;
  }
  nested.biasResolution = { kind: "pending" };
  context.backend.observe(resolveNow(overlay, nested, source, encoding, context));
}

async function resolveNow(
  overlay: SettingsOverlayState,
  nested: NonNullable<SettingsOverlayState["sampling"]>,
  source: AppSource,
  encoding: PromptBiasEncoding,
  context: ActionContext
): Promise<void> {
  const sampling = overlay.draft.sampling;
  const result = await source.api.resolveSamplingBias({
    logitBias: sampling.logitBias,
    phraseBias: sampling.phraseBias,
    bannedStrings: sampling.bannedStrings,
    encoding
  });
  // Stale guard: land the result only if the sampling panel this request
  // started under is still the live one.
  if (overlay.sampling !== nested) return;
  nested.biasResolution = { kind: "ready", result };
  context.repaint();
}
