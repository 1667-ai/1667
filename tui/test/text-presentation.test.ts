import { describe, expect, test } from "bun:test";
import {
  createTextPresentation,
  drainTextPresentation,
  type PresentationClock
} from "../src/text-presentation.js";
import type { StreamView } from "../src/state.js";
import {
  appendStreamText,
  attachStreamPresentation,
  emptyStreamText,
  streamPresentedText
} from "../src/stream-text.js";

class FakeClock implements PresentationClock {
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();
  private current = 0;

  now(): number { return this.current; }

  setTimer(callback: () => void, delay: number): number {
    const id = this.nextId++;
    this.timers.set(id, { at: this.current + delay, callback });
    return id;
  }

  clearTimer(timer: unknown): void {
    this.timers.delete(timer as number);
  }

  runNext(): boolean {
    const next = [...this.timers.entries()]
      .sort((left, right) => left[1].at - right[1].at)[0];
    if (next === undefined) return false;
    this.timers.delete(next[0]);
    this.current = next[1].at;
    next[1].callback();
    return true;
  }

  runAll(): void {
    while (this.runNext()) { /* drain */ }
  }

  advanceBy(milliseconds: number): void {
    this.current += milliseconds;
  }
}

function presentation(clock: FakeClock, onPresented = () => undefined) {
  return createTextPresentation({ clock, onPresented });
}

describe("text presentation", () => {
  test("slow provider text stays immediate with one grapheme held", async () => {
    const clock = new FakeClock();
    const view = presentation(clock);

    view.receive("one ");
    clock.advanceBy(20);
    view.receive("word");

    expect(view.presentedText).toBe("one wor");
    expect(view.pendingLength).toBe(1);
    const settling = view.settle();
    clock.runAll();
    expect(await settling).toBeTrue();
    expect(view.presentedText).toBe("one word");
  });

  test("large provider batches reveal bounded adaptive chunks", () => {
    const clock = new FakeClock();
    const view = presentation(clock);
    view.receive("x".repeat(160));

    expect(view.presentedText.length).toBe(16);
    expect(view.pendingLength).toBe(144);

    view.advance();
    expect(view.presentedText.length).toBe(40);
    view.advance();
    expect(view.presentedText.length).toBe(64);
    expect(view.presentedText.length <= 64).toBeTrue();
  });

  test("configuration cannot raise the normal reveal cap", () => {
    const clock = new FakeClock();
    const initial = createTextPresentation({
      clock,
      initialUnits: 1_000,
      immediateBacklogUnits: 1_000
    });
    initial.receive("x".repeat(100));
    expect(initial.presentedText.length).toBe(48);

    const immediate = createTextPresentation({
      clock: new FakeClock(),
      initialUnits: 8,
      immediateBacklogUnits: 1_000
    });
    immediate.receive("x".repeat(100));
    expect(immediate.presentedText.length).toBe(8);
  });

  test("bounds each presentation step for one pathological provider burst", () => {
    const clock = new FakeClock();
    const lengths: number[] = [];
    const view = presentation(clock);
    const burst = "x".repeat(32_768);

    view.receive(burst);
    lengths.push(view.presentedText.length);
    for (let step = 0; step < 12; step += 1) {
      expect(clock.runNext()).toBeTrue();
      lengths.push(view.presentedText.length);
    }

    expect(view.presentedText.length <= 16 + 12 * 48).toBeTrue();
    expect(view.pendingLength).toBeGreaterThan(0);
    for (let index = 1; index < lengths.length; index += 1) {
      expect(lengths[index]! - lengths[index - 1]! <= 48).toBeTrue();
    }
  });

  test("a queued provider burst keeps moving during a provider pause", () => {
    const clock = new FakeClock();
    const view = presentation(clock);
    view.receive("x".repeat(32_768));
    for (let step = 0; step < 12; step += 1) {
      expect(clock.runNext()).toBeTrue();
    }
    const priorLength = view.presentedText.length;

    expect(clock.runNext()).toBeTrue();

    expect(view.presentedText.length).toBeGreaterThan(priorLength);
  });

  test("queues rapid small deltas inside one presentation cadence", () => {
    const clock = new FakeClock();
    let paints = 0;
    const view = presentation(clock, () => { paints += 1; });

    view.receive("one");
    view.receive(" two");
    view.receive(" three");

    expect(view.presentedText).toBe("on");
    expect(view.pendingLength).toBe(11);
    expect(paints).toBe(1);

    expect(clock.runNext()).toBeTrue();
    expect(view.presentedText).toBe("one two thre");
    expect(view.pendingLength).toBe(1);
    expect(paints).toBe(2);
  });

  test("does not split a surrogate pair across presentation steps", () => {
    const clock = new FakeClock();
    const view = presentation(clock, () => undefined);
    view.receive("\ud83d");

    expect(view.presentedText).toBe("");
    expect(view.pendingLength).toBe(1);

    view.receive("\ude80");
    expect(view.presentedText).toBe("");
    view.receive("x");
    expect(view.presentedText).toBe("🚀");
    expect(view.presentedText).not.toContain("\ufffd");
  });

  test("does not split terminal graphemes across presentation steps", async () => {
    for (const grapheme of ["e\u0301", "☀️", "🇩🇪", "👩‍💻", "\u0600A"]) {
      const clock = new FakeClock();
      const view = presentation(clock);
      const prefix = "x".repeat(15);

      const suffix = "z".repeat(20);
      view.receive(`${prefix}${grapheme}${suffix}`);

      expect(view.presentedText).toBe(prefix);
      view.advance();
      clock.runAll();
      const settling = view.settle();
      clock.runAll();
      expect(await settling).toBeTrue();
      expect(view.presentedText).toBe(`${prefix}${grapheme}${suffix}`);
      view.dispose();
    }
  });

  test("retains grapheme boundaries across every provider-delta split", async () => {
    for (const grapheme of ["e\u0301", "☀️", "🇩🇪", "👩‍💻", "\u0600A"]) {
      const complete = `A${grapheme}B`;
      for (let split = 1; split < complete.length; split += 1) {
        const clock = new FakeClock();
        const view = presentation(clock);
        view.receive(complete.slice(0, split));
        clock.runAll();
        expect(["", "A"]).toContain(view.presentedText);

        view.receive(complete.slice(split));
        clock.runAll();
        expect(view.presentedText).toBe(`A${grapheme}`);

        const settling = view.settle();
        clock.runAll();
        expect(await settling).toBeTrue();
        expect(view.presentedText).toBe(complete);
      }
    }
  });

  test("settles a normal tail before the durable result replaces it", async () => {
    const clock = new FakeClock();
    const view = presentation(clock);
    view.receive("x".repeat(96));
    const settling = view.settle(200);
    clock.runAll();

    expect(await settling).toBeTrue();
    expect(view.presentedText).toBe("x".repeat(96));
    expect(view.pendingLength).toBe(0);
  });

  test("bounded settlement leaves a pathological tail for authoritative adoption", async () => {
    const clock = new FakeClock();
    const view = presentation(clock);
    view.receive("x".repeat(20_000));
    const settling = view.settle(0);

    expect(await settling).toBeFalse();
    expect(view.presentedText.length <= 272).toBeTrue();
    expect(view.pendingLength).toBeGreaterThan(0);
  });

  test("bounded settlement leaves an oversized grapheme for authoritative adoption", async () => {
    const clock = new FakeClock();
    const view = presentation(clock);
    const oversized = `e${"\u0301".repeat(1_000)}`;
    view.receive(oversized);

    const settling = view.settle(0);

    expect(await settling).toBeFalse();
    expect(view.presentedText).toBe("");
    expect(view.pendingLength).toBe(oversized.length);
  });

  test("suspending an active settlement resolves its waiter", async () => {
    const clock = new FakeClock();
    const view = presentation(clock);
    view.receive("x".repeat(1_000));
    const settling = view.settle(200);

    view.suspend();

    expect(await settling).toBeFalse();
    expect(view.pendingLength).toBeGreaterThan(0);
  });

  test("a suspended presentation does not drain during settlement", async () => {
    const clock = new FakeClock();
    const view = presentation(clock);
    view.receive("x".repeat(1_000));
    view.suspend();
    const presented = view.presentedText;
    const pending = view.pendingLength;

    expect(await view.settle()).toBeFalse();
    clock.runAll();
    expect(view.presentedText).toBe(presented);
    expect(view.pendingLength).toBe(pending);
  });

  test("drain keeps an explicitly stopped presentation suspended", async () => {
    const clock = new FakeClock();
    const view = presentation(clock);
    view.receive("x".repeat(1_000));
    view.suspend();
    const presented = view.presentedText;
    const pending = view.pendingLength;

    expect(await drainTextPresentation(view)).toBeFalse();
    expect(view.suspended).toBeTrue();
    expect(view.presentedText).toBe(presented);
    expect(view.pendingLength).toBe(pending);
    expect(clock.runNext()).toBeFalse();
  });

  test("drain uses one deadline, then bypasses a safe tail", async () => {
    const clock = new FakeClock();
    const view = presentation(clock);
    view.receive("x".repeat(20_000));

    const draining = drainTextPresentation(view, 32);
    clock.runAll();

    expect(await draining).toBeTrue();
    expect(view.bypassed).toBeTrue();
    expect(view.pendingLength).toBe(0);
    expect(clock.runNext()).toBeFalse();
  });

  test("failed recovery resumes a suspended stream in bounded steps", () => {
    const clock = new FakeClock();
    const lengths: number[] = [];
    const view = presentation(clock, () => { lengths.push(view.presentedText.length); });
    const beforeStop = "x".repeat(1_000);
    const stoppedTail = "y".repeat(300);
    view.receive(beforeStop);
    view.suspend();
    const suspendedLength = view.presentedText.length;
    view.receive(stoppedTail);
    clock.runAll();
    expect(view.presentedText.length).toBe(suspendedLength);

    view.recover();
    clock.runAll();

    expect(view.presentedText).toBe(beforeStop + stoppedTail);
    for (let index = 1; index < lengths.length; index += 1) {
      expect(lengths[index]! - lengths[index - 1]! <= 256).toBeTrue();
    }
  });

  test("failed recovery quarantines an oversized grapheme without retrying it", () => {
    const clock = new FakeClock();
    const view = presentation(clock);
    const oversized = `e${"\u0301".repeat(1_000)}`;
    view.receive(`${oversized} tail`);
    view.suspend();

    view.recover();
    expect(clock.runNext()).toBeFalse();

    // The cluster stays hidden because recovering it would require an
    // unbounded boundary probe. Recovery enters one-way bypass, while the
    // owner still retains the exact text for authoritative adoption.
    expect(view.presentedText).toBe("");
    expect(view.bypassed).toBeTrue();
    expect(view.pendingLength).toBe(0);
  });

  test("a pathological combining run gets one bounded probe and no recovery spin", () => {
    const clock = new FakeClock();
    const view = presentation(clock);
    const oversized = `e${"\u0301".repeat(100_000)}`;

    view.receive(oversized);
    expect(view.presentedText).toBe("");
    expect(clock.runNext()).toBeFalse();

    view.suspend();
    view.recover();
    expect(clock.runNext()).toBeFalse();
    expect(view.presentedText).toBe("");
    expect(view.bypassed).toBeTrue();
    expect(view.pendingLength).toBe(0);
  });

  test("recovery bypasses a later oversized cluster and exposes authoritative stream text", () => {
    const clock = new FakeClock();
    const stream: StreamView = {
      targetId: "stream",
      parentId: null,
      append: false,
      startedAt: "2026-08-20T00:00:00Z",
      instruction: "",
      ...emptyStreamText()
    };
    const controller = presentation(clock);
    stream.presentation = controller;
    controller.suspend();
    const oversized = `e${"\u0301".repeat(1_000)}`;
    const authoritative = `${"x".repeat(600)}${oversized}`;
    appendStreamText(stream, authoritative);

    controller.recover();
    clock.runAll();

    expect(controller.bypassed).toBeTrue();
    expect(controller.pendingLength).toBe(0);
    expect(clock.runNext()).toBeFalse();
    // The visible prefix may be partial internally, but projection uses the
    // authoritative stream after the one-frame exceptional bypass.
    expect(streamPresentedText(stream)).toBe(authoritative);
  });

  test("disposing presentation does not discard authoritative received text", () => {
    const clock = new FakeClock();
    const stream: StreamView = {
      targetId: "stream",
      parentId: null,
      append: false,
      startedAt: "2026-08-20T00:00:00Z",
      instruction: "",
      ...emptyStreamText()
    };
    attachStreamPresentation(stream, () => undefined);
    const received = "queued provider text ".repeat(3);
    appendStreamText(stream, received);

    expect(stream.presentation?.pendingLength ?? 0).toBeGreaterThan(0);
    stream.presentation?.dispose();

    expect(stream.text).toBe(received);
    expect(stream.presentation?.presentedText).not.toBe(received);
  });
});
