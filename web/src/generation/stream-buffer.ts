/**
 * The authoritative text a generation has received, plus the rAF-throttled
 * scheduler that projects it into the store. Split out of `actions.ts` so
 * both halves are independently testable: a fake scheduler lets the
 * integration test assert "several deltas per frame collapse into one
 * `store.set`" without a real animation frame in the test runner, and the
 * buffer's own substantive/trim rules are exactly the ones the save path
 * (`settle.ts`) must agree with — the same text either module reads.
 *
 * Deliberately far simpler than the TUI's own `stream-text.ts`: that module
 * also drives a character-by-character typewriter presentation for the
 * terminal renderer, which the browser has no equivalent need for (a
 * browser repaints the DOM difference in one frame; there is nothing to
 * smooth). The one rule shared with the TUI on purpose is what counts as
 * "substantive" and how a new-take save is trimmed, because the stop/save
 * contract must agree with the TUI's `stream-text.ts` (`streamHasSubstantiveText`/
 * `streamTrimmedText`) byte-for-byte: whitespace-only never saves, and a new
 * take is trimmed before it lands.
 */

export interface StreamBuffer {
  /** Every delta received so far, verbatim, in arrival order — including
   *  the withheld tail a Stop or a timeout-class failure hands back once at
   *  terminal settlement (`onStopped`). This is the only text the save path
   *  ever reads; the store's presented `text` is a throttled read-only copy
   *  of a prefix of this for rendering. */
  text: string;
  reasoning: { text: string; tokenCount: number } | null;
}

export function createStreamBuffer(): StreamBuffer {
  return { text: "", reasoning: null };
}

export function appendBufferText(buffer: StreamBuffer, delta: string): void {
  if (delta.length === 0) return;
  buffer.text += delta;
}

export function appendBufferReasoning(buffer: StreamBuffer, delta: string, tokenCount: number): void {
  const current = buffer.reasoning?.text ?? "";
  buffer.reasoning = { text: current + delta, tokenCount };
}

/** Whitespace-only text is never worth saving — matches the TUI's own
 *  `streamHasSubstantiveText` (`tui/src/stream-text.ts`). */
export function hasSubstantiveText(text: string): boolean {
  return text.trim().length > 0;
}

/** A new take's text is trimmed before it lands (an append's is not — its
 *  leading/trailing whitespace is the writer's own leaf's, joined at the
 *  exact byte boundary, `shared/story-text.ts`'s `appendContinuationText`).
 *  Matches the TUI's own `streamTrimmedText`. */
export function trimmedText(text: string): string {
  return text.trim();
}

/** Runs `flush` at most once per animation frame, however many times
 *  `schedule` is called in between — `actions.ts`'s `onDelta` calls
 *  `schedule` on every delta; only the last-scheduled frame's callback ever
 *  actually runs, and it reads the buffer fresh at that point, so no delta
 *  is lost even though most of them never get their own `store.set`.
 *  Injectable so a test can supply a synchronous, immediately-flushing fake
 *  instead of a real `requestAnimationFrame` (unavailable to a Node test
 *  runner, and rAF pauses in a hidden tab regardless — this scheduler only
 *  ever governs *presentation* cadence; `actions.ts` always saves from the
 *  authoritative buffer, never from what this last happened to flush). */
export interface FlushScheduler {
  schedule(flush: () => void): void;
  /** Drops a pending frame without running its flush — used when a run
   *  ends, so a frame requested just before settlement never fires against
   *  a closure that has already moved on. */
  cancel(): void;
}

export function createRafFlushScheduler(): FlushScheduler {
  let handle: number | null = null;
  return {
    schedule(flush) {
      if (handle !== null) return;
      handle = requestAnimationFrame(() => {
        handle = null;
        flush();
      });
    },
    cancel() {
      if (handle !== null) {
        cancelAnimationFrame(handle);
        handle = null;
      }
    }
  };
}

/** A manually-driven fake, for `test/web-generation.integration.test.ts`:
 *  `schedule` records the first callback offered for the current "frame"
 *  (matching real `requestAnimationFrame`'s own "only the first call in a
 *  frame's window actually schedules a callback" behavior — every
 *  callback reads the live buffer when it eventually runs, so which one of
 *  several equivalent closures gets kept never changes the result) and
 *  never calls it on its own. A test sends several deltas, asserts nothing
 *  has flushed yet, then calls `runPendingFlush()` once and asserts exactly
 *  one `store.set` happened. */
export interface ManualFlushScheduler extends FlushScheduler {
  /** How many times `schedule` was called while a frame was already
   *  pending — i.e. how many deltas this "frame" coalesced. Reset on flush. */
  readonly pendingScheduleCount: number;
  /** Runs the pending flush, if one is scheduled, and clears it. */
  runPendingFlush(): void;
}

export function createManualFlushScheduler(): ManualFlushScheduler {
  let pending: (() => void) | null = null;
  let pendingScheduleCount = 0;
  return {
    get pendingScheduleCount() {
      return pendingScheduleCount;
    },
    schedule(flush) {
      if (pending === null) pending = flush;
      pendingScheduleCount += 1;
    },
    cancel() {
      pending = null;
      pendingScheduleCount = 0;
    },
    runPendingFlush() {
      const flush = pending;
      pending = null;
      pendingScheduleCount = 0;
      flush?.();
    }
  };
}
