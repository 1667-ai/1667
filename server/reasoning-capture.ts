import type { CapturedReasoning } from "../shared/reasoning.js";
import type { ReasoningConsumer, ReasoningStreamDelta } from "./generation-stream.js";

/**
 * Accumulate a stream's reasoning deltas into one capture, the same
 * collector-box shape as `TokenProbabilityCollector`
 * (server/token-probability-capture.ts): filled as the stream runs, read
 * once the stream ends.
 */
export interface ReasoningCollector {
  record: CapturedReasoning | null;
}

/** Wrap a caller-supplied reasoning consumer — the one that relays deltas
 *  live to an SSE client — so every delta also accumulates into `collector`
 *  before reaching it. The caller's own consumer, if any, always still runs
 *  unchanged: live display and durable capture are independent readers of
 *  the same stream, so wrapping never depends on whether a caller happened
 *  to pass one. `collector.record` stays null when the stream produced no
 *  reasoning, exactly like `TokenProbabilityCollector.record`.
 *
 *  `keep` is the writer's "Keep thoughts" setting, and it gates accumulation
 *  rather than storage. Refusing to retain a thought should mean never
 *  holding the whole of one in memory, not building it and discarding it at
 *  commit time. Live relay is deliberately unaffected: a reader still watches
 *  the model think, the thought just does not outlive the stream. */
export function withReasoningCapture(
  collector: ReasoningCollector,
  onReasoning: ReasoningConsumer | undefined,
  keep: boolean
): ReasoningConsumer {
  return async (delta: ReasoningStreamDelta) => {
    if (keep) {
      const text = (collector.record?.text ?? "") + delta.text;
      collector.record = { text, tokenCount: delta.tokenCount };
    }
    await onReasoning?.(delta);
  };
}
