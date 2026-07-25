export interface FrameClock {
  now(): number;
  setTimer(callback: () => void, delay: number): unknown;
  clearTimer(timer: unknown): void;
}

const SYSTEM_CLOCK: FrameClock = {
  now: () => performance.now(),
  setTimer: (callback, delay) => setTimeout(callback, delay),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)
};

export interface FrameScheduler {
  /** Mark the latest state dirty; builds at most once per frame window. */
  invalidate(reason?: FrameReason): void;
  /** Deterministic initial/capture paint. */
  flush(): void;
  dispose(): void;
  stats(): FrameSchedulerStats;
}

export type FrameReason = "state" | "resize" | "animation" | "cold-ready";

export interface FrameSchedulerStats {
  invalidations: number;
  invalidationsByReason: Readonly<Record<FrameReason, number>>;
  frames: number;
  coalesced: number;
  maxPendingAgeMs: number;
  buildSamplesMs: readonly number[];
}

export interface FrameSchedulerOptions {
  frameMs?: number;
  clock?: FrameClock;
  onError?: (error: unknown) => void;
}

/** Leading/trailing frame throttle: immediate feedback, then one latest-state
 * build per 16ms window while input or stream events keep arriving. */
export function createFrameScheduler(
  build: () => void,
  options: FrameSchedulerOptions = {}
): FrameScheduler {
  const { frameMs = 16, clock = SYSTEM_CLOCK, onError = () => undefined } = options;
  let dirty = false;
  let drawing = false;
  let disposed = false;
  let lastFrameAt = Number.NEGATIVE_INFINITY;
  let timer: unknown = null;
  let dirtySince: number | null = null;
  let invalidations = 0;
  let frames = 0;
  let coalesced = 0;
  let maxPendingAgeMs = 0;
  let sampleCursor = 0;
  const buildSamplesMs: number[] = [];
  const invalidationsByReason: Record<FrameReason, number> = {
    state: 0,
    resize: 0,
    animation: 0,
    "cold-ready": 0
  };

  const draw = () => {
    timer = null;
    if (disposed || !dirty || drawing) return;
    const startedAt = clock.now();
    maxPendingAgeMs = Math.max(maxPendingAgeMs, startedAt - (dirtySince ?? startedAt));
    dirty = false;
    dirtySince = null;
    drawing = true;
    try {
      build();
    } catch (error) {
      try { onError(error); } catch { /* reporting must not poison scheduling */ }
    } finally {
      drawing = false;
      lastFrameAt = clock.now();
      frames += 1;
      pushSample(buildSamplesMs, lastFrameAt - startedAt, sampleCursor++);
      if (dirty) schedule();
    }
  };

  const schedule = () => {
    if (disposed || timer !== null || drawing) return;
    const delay = Math.max(0, frameMs - (clock.now() - lastFrameAt));
    if (delay === 0) draw();
    else timer = clock.setTimer(draw, delay);
  };

  return {
    invalidate(reason = "state") {
      if (disposed) return;
      invalidations += 1;
      invalidationsByReason[reason] += 1;
      if (dirty) coalesced += 1;
      else dirtySince = clock.now();
      dirty = true;
      schedule();
    },
    flush() {
      if (disposed || !dirty) return;
      if (timer !== null) clock.clearTimer(timer);
      timer = null;
      lastFrameAt = Number.NEGATIVE_INFINITY;
      draw();
    },
    dispose() {
      disposed = true;
      dirty = false;
      dirtySince = null;
      if (timer !== null) clock.clearTimer(timer);
      timer = null;
    },
    stats: () => ({
      invalidations,
      invalidationsByReason: { ...invalidationsByReason },
      frames,
      coalesced,
      maxPendingAgeMs,
      buildSamplesMs: [...buildSamplesMs]
    })
  };
}

const MAX_BUILD_SAMPLES = 2_048;

function pushSample(samples: number[], value: number, cursor: number): void {
  if (samples.length < MAX_BUILD_SAMPLES) samples.push(value);
  else samples[cursor % MAX_BUILD_SAMPLES] = value;
}
