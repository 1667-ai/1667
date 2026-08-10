import { createReasoningRecord, MAX_REASONING_BYTES, type CapturedReasoning } from "../shared/reasoning.js";
import type { GenerationSettings } from "../shared/types.js";
import { providerRuntimeFor } from "./provider-runtime.js";
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

/** What a stream's reasoning capture hands back: the collector a caller
 *  reads once the stream ends, and the wrapped consumer to feed the
 *  provider's own `onReasoning` slot. */
export interface ReasoningCapture {
  readonly collector: ReasoningCollector;
  readonly onReasoning: ReasoningConsumer;
}

/** Builds one stream's reasoning capture from settings and the caller's own
 *  live consumer: the "Keep thoughts" default and the collector box,
 *  together, in one call. `continueStory`, `rewriteNode`, and
 *  `createSummaryTake` (server/generation-http.ts, server/summary-take.ts)
 *  each used to repeat the same four lines to get here, including a
 *  copy-pasted comment — this module's own doc claims to be where retention
 *  is decided, so that decision now lives here exactly once, not three
 *  times. Absent `keepReasoning` resolves to kept, so a document written
 *  before the setting existed keeps thoughts. */
export function reasoningCapture(
  settings: GenerationSettings,
  onReasoning: ReasoningConsumer | undefined
): ReasoningCapture {
  const collector: ReasoningCollector = { record: null };
  const keep = providerRuntimeFor(settings).keepReasoning !== false;
  return { collector, onReasoning: withReasoningCapture(collector, onReasoning, keep) };
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
 *  the model think, the thought just does not outlive the stream.
 *
 *  Accumulation itself stops at `MAX_REASONING_BYTES`: past that point the
 *  capture keeps the prefix it already has and drops the rest, rather than
 *  building an unbounded string that `createReasoningRecord` only rejects
 *  whole at commit time (server/story-node-reasoning.ts's `attachTakeReasoning`
 *  swallows that failure, so an unbounded capture stored nothing at all for
 *  a long enough thought). `createReasoningRecord` stays the one place that
 *  bound is defined — this asks it directly, by trial, rather than
 *  duplicating its byte math — so capture can never disagree with storage
 *  about where the line is. */
export function withReasoningCapture(
  collector: ReasoningCollector,
  onReasoning: ReasoningConsumer | undefined,
  keep: boolean
): ReasoningConsumer {
  let truncated = false;
  let rawBytes = 0;
  return async (delta: ReasoningStreamDelta) => {
    if (keep && !truncated) {
      rawBytes += Buffer.byteLength(delta.text, "utf8");
      const candidate = (collector.record?.text ?? "") + delta.text;
      if (rawBytes <= MAX_REASONING_BYTES) {
        collector.record = { text: candidate, tokenCount: delta.tokenCount };
      } else {
        collector.record = { text: longestStorableReasoningPrefix(candidate, delta.tokenCount), tokenCount: delta.tokenCount };
        truncated = true;
      }
    }
    await onReasoning?.(delta);
  };
}

/** The longest prefix of `text` that `createReasoningRecord` still accepts
 *  for `tokenCount`, found by asking it — never by reimplementing its size
 *  bound. Runs at most once per stream: `withReasoningCapture` only calls
 *  this the instant raw accumulation first crosses `MAX_REASONING_BYTES`,
 *  and stops accumulating once it has. */
function longestStorableReasoningPrefix(text: string, tokenCount: number): string {
  let fits = 0;
  let tooLong = text.length + 1;
  while (tooLong - fits > 1) {
    const mid = fits + Math.floor((tooLong - fits) / 2);
    try {
      createReasoningRecord({ text: text.slice(0, mid), tokenCount });
      fits = mid;
    } catch {
      tooLong = mid;
    }
  }
  return text.slice(0, fits);
}
