import { describe, expect, test } from "bun:test";
import { nextAgeChange } from "../../shared/story-model.js";
import {
  createAnimationDeadlineScheduler,
  createFrameDeadlineCollector,
  registerNextDeadline,
  type AnimationClock
} from "../src/animation-deadline.js";
import { initialState } from "../src/app.js";
import { demoAppSource } from "../src/demo.js";
import { createStoryViewModel, rowIndexForNode } from "../src/model.js";
import { renderConnectionBanner } from "../src/screens/connection-banner.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { plainLine } from "../src/screens/story/frame.js";
import { emptyStreamText } from "../src/stream-text.js";

function fakeClock(start = 0) {
  let now = start;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock: AnimationClock = {
    now: () => now,
    setTimer(callback, delayMs) {
      const id = nextId++;
      timers.set(id, { at: now + delayMs, callback });
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
    pending: () => timers.size,
    deadlines: () => [...timers.values()].map(({ at }) => at)
  };
}

describe("animation deadlines", () => {
  test("collects only the nearest strictly-future visible transition", () => {
    const deadlines = createFrameDeadlineCollector(800);
    deadlines.at(1_500);
    deadlines.at(700);
    registerNextDeadline(deadlines, 800, [430, 760, 1_100]);
    deadlines.at(1_000);
    expect(deadlines.next()).toBe(1_000);
  });

  test("replaces, fires, and cancels one timer", () => {
    const fake = fakeClock();
    let frames = 0;
    const scheduler = createAnimationDeadlineScheduler(() => { frames += 1; }, fake.clock);
    scheduler.schedule(1_000);
    scheduler.schedule(500);
    expect(fake.pending()).toBe(1);
    expect(fake.deadlines()).toEqual([500]);
    fake.advance(499);
    expect(frames).toBe(0);
    fake.advance(1);
    expect(frames).toBe(1);
    expect(fake.pending()).toBe(0);
    scheduler.schedule(1_500);
    scheduler.dispose();
    expect(fake.pending()).toBe(0);
  });

  test("visible fresh ink registers each exact fade boundary", () => {
    const state = initialState(demoAppSource(false), false);
    const leaf = state.payload.path.at(-1)!;
    state.focusIndex = rowIndexForNode(createStoryViewModel(state.payload), leaf.id);
    state.now = 1_100;
    state.freshLandedAt = new Map([[leaf.id, 1_000]]);
    const deadlines = createFrameDeadlineCollector(state.now);

    renderStoryScreen(state, { width: 120, height: 36, deadlines });

    expect(deadlines.next()).toBe(1_330);
  });

  test("a silent stream advances one visible liveness mark per frame deadline", () => {
    const state = initialState(demoAppSource(false), false);
    const leaf = state.payload.path.at(-1)!;
    state.focusIndex = rowIndexForNode(createStoryViewModel(state.payload), leaf.id);
    state.stream = {
      targetId: leaf.id,
      parentId: leaf.parentId,
      append: true,
      startedAt: "2026-07-22T00:00:00.000Z",
      instruction: "",
      ...emptyStreamText()
    };
    state.now = 0;
    const firstDeadlines = createFrameDeadlineCollector(state.now);
    const first = renderStoryScreen(state, {
      width: 120, height: 36, deadlines: firstDeadlines
    }).lines.map(plainLine).join("\n");

    state.now = 250;
    const second = renderStoryScreen(state, { width: 120, height: 36 })
      .lines.map(plainLine).join("\n");

    expect(first).toContain("⠋ writing");
    expect(second).toContain("⠙ writing");
    expect(firstDeadlines.next()).toBe(250);
  });

  test("compose focus suppresses the growth pulse when phases collapse to chrome", () => {
    const state = initialState(demoAppSource(false), false);
    state.mode = "COMPOSE";
    state.contextWindow = 10_000;
    state.maxTokens = 2_000;
    state.now = 0;
    state.freshLandedAt = new Map();

    const live = createFrameDeadlineCollector(0);
    renderStoryScreen(state, { width: 140, height: 36, deadlines: live });
    expect(live.next()).toBe(1_200);

    state.config = { ...state.config, composeFocus: "on" };
    const dimmed = createFrameDeadlineCollector(0);
    renderStoryScreen(state, { width: 140, height: 36, deadlines: dimmed });
    expect(dimmed.next()).toBe(null);
  });

  test("retry copy registers the next displayed-second boundary", () => {
    const deadlines = createFrameDeadlineCollector(1_000);
    renderConnectionBanner([[]], {
      now: 1_000,
      connection: { down: true, attempt: 1, nextRetryAt: 3_500, error: "offline" },
      hitRows: [null]
    } as never, 80, deadlines);

    expect(deadlines.next()).toBe(1_500);
  });

  test("age labels register only their next bucket change", () => {
    const touched = Date.parse("2026-07-01T00:00:00.000Z");
    expect(nextAgeChange(
      new Date(touched).toISOString(),
      touched + 12 * 60 * 60 * 1_000
    )).toBe(touched + 86_400_000);
    expect(nextAgeChange(
      new Date(touched).toISOString(),
      touched + 9 * 86_400_000
    )).toBe(touched + 14 * 86_400_000);
  });
});
