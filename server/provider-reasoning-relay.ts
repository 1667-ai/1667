import type { GenerationSettings } from "../shared/types.js";
import { createProviderStreamRedactor } from "./provider-runtime.js";
import { requireProviderOutputWithinLimit } from "./provider-stream-output.js";

/**
 * The reasoning-relay side of `server/providers.ts`'s two streaming
 * generators: one small object that owns everything a single attempt needs
 * to turn provider-specific reasoning deltas into `onReasoning` calls.
 * `streamOpenAiCompatible` and `streamAnthropic` used to each hold this
 * cluster inline — a redactor, a decoded-byte counter, and a running token
 * count, kept in lockstep by hand across six call sites in two ~180-line
 * generators. Split out so the two providers share one relay instead of two
 * copies that must agree by comment.
 */

/** One increment of model reasoning ("thinking") text, kept strictly apart
 * from story prose: prose reaches a caller only through `streamCompletion`'s
 * `AsyncGenerator<string>`, reasoning only through `onReasoning` below, and
 * the two never share a redactor or a decoded-byte budget. `tokenCount` is
 * the running total for the reasoning stream so far — a provider-reported
 * count when the stream trivially exposes one, otherwise the number of
 * reasoning deltas received (never a fabricated denominator). */
export interface ReasoningStreamDelta {
  readonly text: string;
  readonly tokenCount: number;
}

export type ReasoningConsumer = (delta: ReasoningStreamDelta) => void | Promise<void>;

export interface ReasoningRelay {
  /** Feeds one already-extracted reasoning delta through the relay's own
   *  redactor and decoded-byte budget — never the prose ones. A no-op when
   *  `text` is empty, matching every call site's own former guard.
   *  `reportedCount`, when a provider trivially exposes a running reasoning-
   *  token count on this event, replaces the delta-counting fallback for
   *  this call and every one after it; `null` or `undefined` keeps counting
   *  deltas. */
  push(text: string, reportedCount?: number | null): Promise<void>;
  /** Flushes whatever the redactor is still holding back for a possible
   *  secret match, at whichever of the generator's terminal points is
   *  reached — protocol terminal, natural stream end, or a caught error. */
  finish(): Promise<void>;
}

/** Builds one attempt's reasoning relay: its own redactor and its own
 *  decoded-byte counter, matching the provider's own `outputRedactor` in
 *  shape but never sharing its instance, its budget, or its secret-match
 *  state (`server/provider-runtime.ts`'s `createProviderStreamRedactor`,
 *  `server/provider-stream-output.ts`'s `requireProviderOutputWithinLimit`).
 *
 *  A fresh relay per attempt is the per-attempt freshness invariant this
 *  exists to enforce by construction: `streamOpenAiCompatible` and
 *  `streamAnthropic` each call this once per retry loop iteration, so a
 *  retried attempt's partial redactor state and token count can never mix
 *  into the attempt that actually finishes — there is no shared counter a
 *  second call could accidentally inherit. */
export function createReasoningRelay(
  settings: GenerationSettings,
  secrets: readonly string[],
  onReasoning?: ReasoningConsumer
): ReasoningRelay {
  const redactor = createProviderStreamRedactor(secrets);
  let decodedBytes = 0;
  let tokenCount = 0;
  return {
    async push(text, reportedCount) {
      if (text.length === 0) return;
      decodedBytes = requireProviderOutputWithinLimit(settings, decodedBytes, text);
      tokenCount = reportedCount ?? tokenCount + 1;
      const safe = redactor.push(text);
      if (safe.length > 0 && onReasoning !== undefined) {
        await onReasoning({ text: safe, tokenCount });
      }
    },
    async finish() {
      const tail = redactor.finish();
      if (tail.length > 0 && onReasoning !== undefined) {
        await onReasoning({ text: tail, tokenCount });
      }
    }
  };
}
