import { describe, expect, test } from "bun:test";
import { createFrameScheduler, type FrameClock } from "../src/frame-scheduler.js";

function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock: FrameClock = {
    now: () => now,
    setTimer(callback, delay) {
      const id = nextId++;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimer(timer) { timers.delete(timer as number); }
  };
  return {
    clock,
    advance(milliseconds: number) {
      now += milliseconds;
      for (const [id, timer] of [...timers].sort((left, right) => left[1].at - right[1].at)) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.callback();
      }
    },
    pending: () => timers.size
  };
}

describe("frame scheduler", () => {
  test("paints the leading event immediately and coalesces a burst", () => {
    const fake = fakeClock();
    let frames = 0;
    const scheduler = createFrameScheduler(() => { frames += 1; }, { frameMs: 16, clock: fake.clock });
    scheduler.invalidate();
    expect(frames).toBe(1);
    for (let event = 0; event < 100; event += 1) scheduler.invalidate();
    expect(frames).toBe(1);
    expect(fake.pending()).toBe(1);
    fake.advance(16);
    expect(frames).toBe(2);
  });

  test("a build-time invalidation schedules one follow-up", () => {
    const fake = fakeClock();
    let frames = 0;
    let scheduler: ReturnType<typeof createFrameScheduler>;
    scheduler = createFrameScheduler(() => {
      frames += 1;
      if (frames === 1) scheduler.invalidate();
    }, { frameMs: 16, clock: fake.clock });
    scheduler.invalidate();
    expect(frames).toBe(1);
    expect(fake.pending()).toBe(1);
    fake.advance(0);
    expect(frames).toBe(1);
    fake.advance(15);
    expect(frames).toBe(1);
    fake.advance(1);
    expect(frames).toBe(2);
  });

  test("flush publishes pending render state before an interaction reads it", () => {
    const fake = fakeClock();
    let state = "story";
    let rendered = "";
    const scheduler = createFrameScheduler(() => { rendered = state; }, { frameMs: 16, clock: fake.clock });
    scheduler.invalidate();
    state = "panel";
    scheduler.invalidate();

    expect(rendered).toBe("story");
    expect(fake.pending()).toBe(1);
    scheduler.flush();
    expect(rendered).toBe("panel");
    expect(fake.pending()).toBe(0);
  });

  test("dispose cancels trailing work", () => {
    const fake = fakeClock();
    let frames = 0;
    const scheduler = createFrameScheduler(() => { frames += 1; }, { frameMs: 16, clock: fake.clock });
    scheduler.invalidate();
    scheduler.invalidate();
    scheduler.dispose();
    fake.advance(16);
    expect(frames).toBe(1);
    expect(fake.pending()).toBe(0);
  });

  test("a failed build reports once and preserves follow-up work", () => {
    const fake = fakeClock();
    const errors: unknown[] = [];
    let builds = 0;
    let scheduler: ReturnType<typeof createFrameScheduler>;
    scheduler = createFrameScheduler(() => {
      builds += 1;
      if (builds === 1) {
        scheduler.invalidate();
        throw new Error("paint broke");
      }
    }, { frameMs: 16, clock: fake.clock, onError: (error) => errors.push(error) });

    scheduler.invalidate();
    expect(errors).toHaveLength(1);
    expect(fake.pending()).toBe(1);
    fake.advance(16);
    expect(builds).toBe(2);
    expect(errors).toHaveLength(1);
  });

  test("reports bounded coalescing, reason, pending-age, and build metrics", () => {
    const fake = fakeClock();
    const scheduler = createFrameScheduler(() => {
      fake.advance(2);
    }, { frameMs: 16, clock: fake.clock });
    scheduler.invalidate("state");
    scheduler.invalidate("animation");
    scheduler.invalidate("resize");
    fake.advance(16);
    const stats = scheduler.stats();
    expect(stats.invalidations).toBe(3);
    expect(stats.invalidationsByReason).toMatchObject({ state: 1, animation: 1, resize: 1 });
    expect(stats.frames).toBe(2);
    expect(stats.coalesced).toBe(1);
    expect(stats.maxPendingAgeMs).toBe(16);
    expect(stats.buildSamplesMs).toEqual([2, 2]);
  });
});
