import { describe, expect, test } from "bun:test";
import { initialState } from "../src/app.js";
import type { RuntimeState } from "../src/state.js";
import { demoAppSource } from "../src/demo.js";
import { buildRailModel } from "../src/rail.js";
import type { HitRows } from "../src/hit.js";
import { nextRequestEstimate, type NextRequestContext } from "../src/request-projection.js";
import { renderFactsRail } from "../src/screens/story/facts-rail.js";
import { panelRowWindow } from "../src/screens/panel-table-layout.js";
import { frameText, plainLine, segment, sliceFrame, visibleWidth } from "../src/screens/story/frame.js";
import { deriveStoryFrameLayout } from "../src/story-frame-layout.js";

/** A vault after a lorebook import: far more facts than any pane can show. */
function manyFactsState(
  count: number,
  keyed: ReadonlyArray<{ index: number; key: string }> = []
): RuntimeState {
  const state = initialState(demoAppSource(), true);
  const template = state.payload.facts[0]!;
  const keyedByIndex = new Map(keyed.map((entry) => [entry.index, entry.key]));
  state.payload = {
    ...state.payload,
    facts: Array.from({ length: count }, (_, index) => ({
      ...template,
      id: `fact-${index}`,
      text: `Fact ${String(index).padStart(3, "0")}\nBody line for fact ${index}.`,
      ...(keyedByIndex.has(index)
        ? { activation: "keyed" as const, keys: [keyedByIndex.get(index)!] }
        : { activation: "always" as const, keys: [] })
    }))
  };
  return state;
}

function paintRail(state: RuntimeState, height: number) {
  const layout = deriveStoryFrameLayout(140, state.config);
  const payload = state.payload;
  const next: NextRequestContext = {
    systemPrompt: "Write vivid prose.",
    instruction: "",
    assistantPrefill: true,
    operation: "continue",
    targetId: payload.path.at(-1)!.id,
    // Scale, not window pressure, is what this suite exercises.
    contextWindow: null,
    maxTokens: 0
  };
  const model = buildRailModel(payload, "", 10_000, nextRequestEstimate(payload, next));
  const hits: HitRows = Array.from({ length: height }, () => null);
  const lines = renderFactsRail(
    Array.from({ length: height }, () => [segment(" ".repeat(layout.pageWidth))]),
    model, hits, height, layout
  );
  const rail = sliceFrame(
    lines, layout.pageWidth, (layout.railRight ?? layout.fullWidth) - layout.pageWidth
  );
  return { model, rail, hits, lines };
}

describe("facts rail at lorebook scale", () => {
  test("active keyed facts outrank always-on, dormant keyed facts sink", () => {
    // "Maren" appears in the demo prose; the zz key matches nothing.
    const state = manyFactsState(6, [
      { index: 5, key: "Maren" },
      { index: 3, key: "zz-matches-nothing" }
    ]);
    const { model } = paintRail(state, 16);

    expect(model.facts.map((fact) => fact.index)).toEqual([5, 0, 1, 2, 4, 3]);
    expect(model.facts[0]?.status.kind).toBe("sent");
    expect(model.facts.at(-1)?.activation).toBe("keyed");
    expect(model.facts.at(-1)?.status.kind).toBe("not-matched");
  });

  test("a clipped rail names how many facts it hid", () => {
    const { model, rail } = paintRail(manyFactsState(128), 14);
    const text = frameText(rail);
    const tail = text.match(/· (\d+) more/);
    const shown = text.match(/Fact \d{3}/g) ?? [];

    expect(model.facts).toHaveLength(128);
    expect(text).toContain("facts · 128");
    expect(text).toContain("Fact 000");
    expect(tail === null).toBe(false);
    expect(Number(tail![1]) + shown.length).toBe(128);
  });

  test("an unclipped rail keeps its tail to itself", () => {
    const text = frameText(paintRail(manyFactsState(2), 16).rail);

    expect(text).not.toContain("more");
    expect(text).toContain("Fact 000");
    expect(text).toContain("Fact 001");
  });

  test("frame geometry survives 128 facts at any pane height", () => {
    const state = manyFactsState(128);
    for (const height of [2, 3, 6, 14, 36]) {
      const { lines } = paintRail(state, height);
      expect(lines).toHaveLength(height);
      for (const line of lines) {
        expect(visibleWidth(plainLine(line)) <= 140).toBe(true);
      }
    }
  });

  test("a complete trailing fact that lost only its air row is not popped", () => {
    // Walk pane heights until the cut lands exactly after the second fact's
    // name row: [header, air, Fact 000, air, Fact 001]. That fact is whole —
    // the rail must keep it and claim nothing hidden.
    const state = manyFactsState(2);
    let exercised = false;
    for (let height = 4; height <= 30; height += 1) {
      const texts = paintRail(state, height).rail.map((line) =>
        plainLine(line).replace(/^│/, "").trim());
      const meterStart = texts.findIndex((line) =>
        /^─+$/.test(line) || line.includes("next request"));
      if (meterStart < 0) continue;
      const body = texts.slice(0, meterStart);
      while (body.length > 0 && body.at(-1) === "") body.pop();
      if (body.length === 5 && body[2]!.includes("Fact 000") && body[4]!.includes("Fact 001")) {
        exercised = true;
        expect(texts.join("\n")).not.toContain("more");
      }
    }
    expect(exercised).toBe(true);
  });

  test("tail arithmetic holds at every pane height", () => {
    for (const count of [2, 128]) {
      const state = manyFactsState(count);
      for (let height = 4; height <= 24; height += 1) {
        const text = frameText(paintRail(state, height).rail);
        const tail = text.match(/· (\d+) more/);
        const visible = (text.match(/Fact \d{3}/g) ?? []).length;
        if (tail !== null) expect(visible + Number(tail[1])).toBe(count);
        if (visible === count) expect(tail).toBe(null);
        // Hidden facts must be named whenever any fact is visible; only a
        // pane too short to show a single fact may stay silent.
        if (count - visible > 0 && visible >= 1) expect(tail === null).toBe(false);
      }
    }
  });

  test("rail clicks open the exact payload fact after reordering", () => {
    const state = manyFactsState(6, [{ index: 5, key: "Maren" }]);
    const { hits } = paintRail(state, 16);
    // Row 0 header, row 1 air; row 2 is the first fact — the active one.
    expect(hits[2]?.target).toEqual({ kind: "fact", index: 5 });
  });
});

describe("panel row window at the fact ceiling", () => {
  const heights = Array.from({ length: 128 }, () => 1);

  test("cursor at the top anchors the window", () => {
    expect(panelRowWindow(heights, 0, 10)).toEqual({ start: 0, end: 10 });
  });

  test("cursor at the last row stays visible", () => {
    const window = panelRowWindow(heights, 127, 10);
    expect(window.end).toBe(128);
    expect(window.start).toBe(118);
  });

  test("cursor mid-list is always inside the window", () => {
    const window = panelRowWindow(heights, 64, 10);
    expect(window.start <= 64).toBe(true);
    expect(window.end > 64).toBe(true);
    expect(window.end - window.start).toBe(10);
  });
});
