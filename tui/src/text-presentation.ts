import { graphemePrefixLength } from "./cell-width.js";

/**
 * Paces text that arrives faster than a writer can comfortably read.
 *
 * The owner keeps the received text separately. This object only owns the
 * visible prefix and the text waiting behind that prefix. A tick can
 * therefore be stopped without changing the text that a mutation commits.
 */
export interface PresentationClock {
  now(): number;
  setTimer(callback: () => void, delay: number): unknown;
  clearTimer(timer: unknown): void;
}

const SYSTEM_CLOCK: PresentationClock = {
  now: () => performance.now(),
  setTimer: (callback, delay) => setTimeout(callback, delay),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)
};

export interface TextPresentationOptions {
  /** The normal presentation interval. It matches the frame cadence. */
  intervalMs?: number;
  /** Immediate prefix for the first fast provider batch. */
  initialUnits?: number;
  /** Backlog under this size is safe to present in the receive callback. */
  immediateBacklogUnits?: number;
  /** Clock seam for deterministic behavior tests. */
  clock?: PresentationClock;
  /** Called after the visible prefix grows. */
  onPresented?: () => void;
}

export interface TextPresentation {
  /** Text that is safe for the UI to show now. */
  readonly presentedText: string;
  /** UTF-16 bounds of the substantive part of `presentedText`. */
  readonly presentedTrimStart: number;
  readonly presentedTrimEnd: number;
  /** UTF-16 length still waiting to be shown. */
  readonly pendingLength: number;
  /** True after recovery cannot safely find the next grapheme boundary. */
  readonly bypassed: boolean;
  /** True while an explicit Stop has frozen visible presentation work. */
  readonly suspended: boolean;
  /** Accept text without waiting for the next provider or frame. */
  receive(delta: string): void;
  /** Present one normal interval. Mainly useful to deterministic tests. */
  advance(): boolean;
  /** Drain the queue before a durable result replaces the live view. */
  settle(maxWaitMs?: number): Promise<boolean>;
  /** Drop only the presentation queue and expose authoritative text upstream. */
  bypass(): void;
  /** Pause visible work while authoritative text can continue to arrive. */
  suspend(): void;
  /** Resume visible work after an explicit stop has durably settled. */
  resume(): void;
  /** Reveal failed-recovery text in bounded steps. Return whether one step
   * made visible progress. */
  recover(): boolean;
  /** Stop timers. The owner's received text remains untouched. */
  dispose(): void;
}

const DEFAULT_INTERVAL_MS = 16;
const DEFAULT_INITIAL_UNITS = 16;
const DEFAULT_IMMEDIATE_BACKLOG_UNITS = 24;
const DEFAULT_SETTLE_MS = 300;
const MAX_NORMAL_UNITS = 48;
const TRIM_CHARACTER = /^\s$/u;
const MAX_DRAIN_UNITS = 256;

/**
 * Create a presentation buffer. Budgets use UTF-16 length for predictable
 * work. Each normal slice keeps its last grapheme until more input confirms
 * the boundary. Terminal settlement can reveal that last grapheme.
 */
export function createTextPresentation(
  options: TextPresentationOptions = {}
): TextPresentation {
  const intervalMs = Math.max(1, Math.floor(options.intervalMs ?? DEFAULT_INTERVAL_MS));
  const initialUnits = Math.min(
    MAX_NORMAL_UNITS,
    Math.max(1, Math.floor(options.initialUnits ?? DEFAULT_INITIAL_UNITS))
  );
  const immediateBacklogUnits = Math.min(
    MAX_NORMAL_UNITS,
    Math.max(initialUnits, Math.floor(options.immediateBacklogUnits ?? DEFAULT_IMMEDIATE_BACKLOG_UNITS))
  );
  const clock = options.clock ?? SYSTEM_CLOCK;
  const onPresented = options.onPresented ?? (() => undefined);
  let presentedText = "";
  let presentedTrimStart = 0;
  let presentedTrimEnd = 0;
  let pendingText = "";
  let timer: unknown = null;
  let disposed = false;
  let bypassed = false;
  let suspended = false;
  let recovering = false;
  // A zero-length probe can mean that the pending prefix is one grapheme
  // larger than the bounded segmentation budget. Remember the unchanged
  // queue length so a timer or recovery call does not retry that same probe
  // forever. New provider bytes change the probe and may establish its end.
  let quarantinedPendingLength: number | null = null;
  let nextRevealAt = Number.NEGATIVE_INFINITY;
  let settling: {
    deadline: number;
    resolve: (complete: boolean) => void;
  } | null = null;

  const notify = () => {
    try {
      onPresented();
    } catch {
      // A repaint failure must not stop provider ingestion or text draining.
    }
  };

  const clearScheduled = () => {
    if (timer === null) return;
    clock.clearTimer(timer);
    timer = null;
  };

  // A recovery step that cannot find a bounded grapheme boundary must be
  // one-way. Clear only the presentation queue, keep the owner's
  // authoritative text untouched, and let the stream projection fall back to
  // that text. This also prevents a later callback from re-hiding it behind
  // the same quarantined prefix.
  const enterBypass = () => {
    if (bypassed) return;
    bypassed = true;
    recovering = false;
    pendingText = "";
    clearScheduled();
    finishSettlement(true);
    notify();
  };

  const reveal = (
    units: number,
    terminal = false,
    includeOversized = false
  ): boolean => {
    if (pendingText.length === 0 || units <= 0) return false;
    const limit = Math.min(pendingText.length, Math.max(1, Math.floor(units)));
    const length = safePrefixLength(pendingText, limit, terminal, includeOversized);
    if (length === 0) {
      quarantinedPendingLength = pendingText.length;
      return false;
    }
    const oldLength = presentedText.length;
    const chunk = pendingText.slice(0, length);
    const chunkBounds = trimBounds(chunk);
    presentedText += chunk;
    pendingText = pendingText.slice(length);
    quarantinedPendingLength = null;
    if (chunkBounds.end > chunkBounds.start) {
      if (presentedTrimEnd <= presentedTrimStart) {
        presentedTrimStart = oldLength + chunkBounds.start;
      }
      presentedTrimEnd = oldLength + chunkBounds.end;
    }
    if (pendingText.length === 0) recovering = false;
    nextRevealAt = clock.now() + intervalMs;
    notify();
    return true;
  };

  const normalUnits = (backlog: number): number => {
    return backlog <= 48
      ? 16
      : backlog <= 192
        ? 24
        : backlog <= 512
          ? 32
          : MAX_NORMAL_UNITS;
  };

  const drainUnits = (backlog: number, remainingMs: number): number => {
    // Small backlogs keep the same readable cadence. Large backlogs catch up
    // at the terminal boundary, but each visible step remains bounded.
    const proportional = Math.ceil(backlog / 8);
    const urgency = remainingMs <= 64 ? 192 : remainingMs <= 160 ? 128 : 64;
    return Math.min(MAX_DRAIN_UNITS, Math.max(32, proportional, urgency));
  };

  const finishSettlement = (complete: boolean) => {
    const active = settling;
    settling = null;
    clearScheduled();
    active?.resolve(complete);
  };

  const settleStep = () => {
    timer = null;
    if (disposed) {
      finishSettlement(false);
      return;
    }
    if (pendingText.length === 0) {
      finishSettlement(true);
      return;
    }
    const active = settling;
    if (active === null) {
      schedule();
      return;
    }
    const remainingMs = active.deadline - clock.now();
    if (remainingMs <= 0) {
      // Bound both wait time and synchronous work. The caller owns the full
      // provider result and replaces any remaining prefix after this step.
      reveal(Math.min(MAX_DRAIN_UNITS, pendingText.length), true);
      finishSettlement(false);
      return;
    }
    const changed = reveal(
      drainUnits(pendingText.length, remainingMs),
      true
    );
    if (pendingText.length === 0) {
      finishSettlement(true);
      return;
    }
    timer = clock.setTimer(
      settleStep,
      changed ? Math.min(intervalMs, remainingMs) : remainingMs
    );
  };

  const schedule = () => {
    if (disposed
      || bypassed
      || suspended
      || timer !== null
      || pendingText.length === 0
      || quarantinedPendingLength === pendingText.length) return;
    const delay = Math.max(0, nextRevealAt - clock.now()) || intervalMs;
    timer = clock.setTimer(() => {
      timer = null;
      if (disposed) return;
      if (settling !== null) {
        settleStep();
        return;
      }
      if (recovering) {
        const changed = reveal(MAX_DRAIN_UNITS, true, true);
        if (changed) schedule();
        else enterBypass();
        return;
      }
      const changed = reveal(normalUnits(pendingText.length));
      if (changed) schedule();
    }, delay);
  };

  return {
    get presentedText() { return presentedText; },
    get presentedTrimStart() { return presentedTrimStart; },
    get presentedTrimEnd() { return presentedTrimEnd; },
    get pendingLength() { return pendingText.length; },
    get bypassed() { return bypassed; },
    get suspended() { return suspended; },
    receive(delta) {
      if (disposed || bypassed || delta.length === 0) return;
      const wasEmpty = pendingText.length === 0;
      const cadenceReady = clock.now() >= nextRevealAt;
      pendingText += delta;
      if (suspended) return;
      const immediate = cadenceReady && pendingText.length <= immediateBacklogUnits
        ? pendingText.length
        : cadenceReady && wasEmpty && presentedText.length === 0
          ? initialUnits
          : 0;
      if (immediate > 0
        && quarantinedPendingLength !== pendingText.length) reveal(immediate);
      schedule();
    },
    advance() {
      if (disposed || suspended || pendingText.length === 0) return false;
      clearScheduled();
      if (settling !== null) {
        settleStep();
        return true;
      }
      if (recovering) {
        const changed = reveal(MAX_DRAIN_UNITS, true, true);
        if (changed) schedule();
        else enterBypass();
        return changed;
      }
      const changed = reveal(normalUnits(pendingText.length));
      if (changed) schedule();
      return changed;
    },
    settle(maxWaitMs = DEFAULT_SETTLE_MS) {
      if (disposed || pendingText.length === 0) return Promise.resolve(true);
      if (suspended) return Promise.resolve(false);
      if (settling !== null) return new Promise((resolve) => {
        const previous = settling!;
        const resolvePrevious = previous.resolve;
        previous.resolve = (complete) => {
          resolvePrevious(complete);
          resolve(complete);
        };
      });
      clearScheduled();
      return new Promise((resolve) => {
        settling = {
          deadline: clock.now() + Math.max(0, maxWaitMs),
          resolve
        };
        settleStep();
      });
    },
    suspend() {
      if (disposed) return;
      suspended = true;
      recovering = false;
      if (settling === null) clearScheduled();
      else finishSettlement(false);
    },
    resume() {
      if (disposed) return;
      suspended = false;
      schedule();
    },
    recover() {
      if (disposed || bypassed) return false;
      suspended = false;
      recovering = true;
      clearScheduled();
      const changed = reveal(MAX_DRAIN_UNITS, true, true);
      if (changed) schedule();
      else enterBypass();
      return changed;
    },
    bypass() {
      enterBypass();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearScheduled();
      finishSettlement(false);
      pendingText = "";
    }
  };
}

/** Finish one controller within one absolute catch-up budget. A false settle
 * can mean an explicit Stop, not only a deadline or grapheme quarantine, so
 * never recover a suspended controller here. A live controller that reaches
 * its deadline enters one-way bypass: the owner still has the exact text, and
 * its projection can show that authoritative text for the exceptional frame.
 * This intentionally hides the remaining suffix instead of rendering a
 * partial grapheme or scheduling an unbounded retry. */
export async function drainTextPresentation(
  presentation: TextPresentation,
  maxWaitMs = DEFAULT_SETTLE_MS
): Promise<boolean> {
  const settled = await presentation.settle(maxWaitMs);
  if (settled || presentation.pendingLength === 0 || presentation.bypassed) return true;
  if (presentation.suspended) return false;
  // `settle` has already consumed the one bounded deadline. Do not start a
  // second 300 ms cycle or call `recover`, which would make Escape thaw the
  // frozen view. Bypass is one-way and emits one repaint notification.
  presentation.bypass();
  return true;
}

function trimBounds(text: string): { start: number; end: number } {
  let first = -1;
  let last = 0;
  let offset = 0;
  for (const character of text) {
    const end = offset + character.length;
    if (!TRIM_CHARACTER.test(character)) {
      if (first < 0) first = offset;
      last = end;
    }
    offset = end;
  }
  return first < 0 ? { start: 0, end: 0 } : { start: first, end: last };
}

/** Return a prefix that ends on a terminal grapheme boundary. */
function safePrefixLength(
  text: string,
  limit: number,
  terminal: boolean,
  includeOversized: boolean
): number {
  return graphemePrefixLength(text, limit, {
    includeOversized,
    retainLast: !terminal
  });
}
