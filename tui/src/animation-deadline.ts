export interface AnimationClock {
  now(): number;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(timer: unknown): void;
}

const SYSTEM_CLOCK: AnimationClock = {
  now: () => Date.now(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)
};

export interface AnimationDeadlineScheduler {
  schedule(deadline: number | null): void;
  dispose(): void;
}

export interface FrameDeadlineCollector {
  at(deadline: number): void;
  next(): number | null;
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Renderers register only strictly-future instants that can change pixels. */
export function createFrameDeadlineCollector(now: number): FrameDeadlineCollector {
  let nearest: number | null = null;
  return {
    at(deadline) {
      if (!Number.isFinite(deadline) || deadline <= now) return;
      nearest = nearest === null ? deadline : Math.min(nearest, deadline);
    },
    next: () => nearest
  };
}

/** Register the next boundary in a finite ordered sequence. */
export function registerNextDeadline(
  collector: FrameDeadlineCollector | undefined,
  now: number,
  deadlines: readonly number[]
): void {
  if (collector === undefined) return;
  for (const deadline of deadlines) {
    if (deadline > now) {
      collector.at(deadline);
      return;
    }
  }
}

/** One replaceable nearest-deadline timer. Early timers re-arm rather than
 * publishing a frame before its displayed state can change. */
export function createAnimationDeadlineScheduler(
  onDeadline: () => void,
  clock: AnimationClock = SYSTEM_CLOCK
): AnimationDeadlineScheduler {
  let deadline: number | null = null;
  let timer: unknown = null;
  let disposed = false;

  const clear = () => {
    if (timer !== null) clock.clearTimer(timer);
    timer = null;
  };
  const arm = () => {
    if (disposed || deadline === null) return;
    timer = clock.setTimer(fire, Math.min(MAX_TIMER_DELAY_MS, Math.max(0, deadline - clock.now())));
  };
  const fire = () => {
    timer = null;
    if (disposed || deadline === null) return;
    if (clock.now() < deadline) return arm();
    deadline = null;
    try { onDeadline(); } catch { /* animation must not poison input */ }
  };

  return {
    schedule(next) {
      if (disposed || next === deadline) return;
      clear();
      deadline = next;
      arm();
    },
    dispose() {
      disposed = true;
      deadline = null;
      clear();
    }
  };
}
