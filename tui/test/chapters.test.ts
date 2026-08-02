import { describe, expect, test } from "bun:test";
import type { ChapterBreak, NodeStub, StoryNode, StoryPayload } from "../../shared/types.js";
import {
  CONSOLE_REPORT,
  assertWithinBudget,
  budgetTimeout,
  cpuBudget,
  startTiming
} from "../../test/performance-budget.js";
import { initialState } from "../src/app.js";
import { chapterListModel, chapterWindow } from "../src/chapter-model.js";
import { createDemoController, demoAppSource } from "../src/demo.js";
import type { HitRows } from "../src/hit.js";
import { createStoryViewModel } from "../src/model.js";
import { nextRequestEstimate, type NextRequestContext } from "../src/request-projection.js";
import { buildRailModel, formatTokensEstimate } from "../src/rail.js";
import { renderPanels } from "../src/screens/panels.js";
import { frameText, type FrameLine } from "../src/screens/story/frame.js";

// Bun applies a 5s default timeout, which is below the allowance this budget
// needs on a loaded runner.
//
// This budget is larger than the wall-clock budget it replaced. Bun collects
// garbage on other threads, and process.cpuUsage counts every thread, so this
// allocation-heavy model reports more CPU time than wall-clock time. A hosted
// runner measured 325.7ms of CPU time against 166.7ms of wall-clock time, where
// this machine measured 147.1ms of CPU time.
const BULK_MODEL_BUDGET = cpuBudget(1_500);

describe("chapter view models", () => {
  test("derives divider and dead-end summary rows without putting summaries on the prose path", () => {
    const payload = createDemoController().payload();
    const view = createStoryViewModel(payload);
    expect(payload.path.some((node) => node.chapterBreakId !== undefined)).toBeFalse();
    expect(view.chapters.map((chapter) => [chapter.number, chapter.title, chapter.startPart, chapter.endPart])).toEqual([
      [1, "", 1, 5], [2, "The Stranger", 6, 10], [3, "The Compass", 11, 13]
    ]);
    expect(view.rows.filter((row) => row.kind === "chapter-divider")).toHaveLength(2);
    expect(view.rows.filter((row) => row.kind === "chapter-summary")).toHaveLength(1);
  });

  test("staleness and legacy-summary resets surface from shared context truth", () => {
    const demo = createDemoController();
    let payload = demo.editNode("p1", { text: "Maren changed the opening after the recap." });
    expect(createStoryViewModel(payload).chapters[0]?.stale).toBeTrue();

    payload = structuredClone(createDemoController().payload());
    payload.path[7]!.role = "summary";
    const stub = payload.nodes.find((node) => node.id === payload.path[7]!.id)!;
    stub.role = "summary";
    const model = chapterListModel(payload, 32_768, estimateFor(payload));
    expect(model.rows[0]?.sent).toBeFalse();
    expect(model.rows[0]?.status).toBe("not sent");
    expect(model.rows[1]?.sent).toBeTrue();
  });

  test("over-budget hint picks only the largest positive-savings raw chapter", () => {
    const payload = structuredClone(createDemoController().payload());
    const prose = payload.path.find((node) => node.id === "p6")!;
    prose.text += ` ${"texture ".repeat(2_000)}`;
    payload.nodes.find((node) => node.id === "p6")!.tokens = 2_000;
    const model = chapterListModel(payload, 100, estimateFor(payload));
    expect(model.over).toBeGreaterThan(0);
    expect(model.biggestUnsummarized?.number).toBe(2);
    expect(model.rows.find((row) => row.chapter.number === 2)?.biggestFix).toBeTrue();
  });

  test("focused-seam advice excludes later chapters absent from the request", () => {
    const payload = structuredClone(createDemoController().payload());
    const later = payload.path.find((node) => node.id === "p6")!;
    later.text += ` ${"texture ".repeat(2_000)}`;
    payload.nodes.find((node) => node.id === later.id)!.tokens = 2_000;

    const model = chapterListModel(payload, 100, estimateFor(payload, "p5"));
    expect(model.over).toBeGreaterThan(0);
    expect(model.biggestUnsummarized).toBe(null);
    expect(model.rows.find((row) => row.chapter.number === 2)?.sent).toBeFalse();
    expect(model.rows.find((row) => row.chapter.number === 2)?.biggestFix).toBeFalse();
  });

  test("partial requests never borrow whole-story summary, stale, closure, or token status", () => {
    const payload = createDemoController().editNode("p1", {
      text: "Maren changed the opening after its stored chapter summary."
    });
    const early = estimateFor(payload, "p2");
    const chapterOne = early.chapters.find((chapter) => chapter.number === 1)!;
    const earlyRow = chapterListModel(payload, 32_768, early).rows
      .find((row) => row.chapter.number === 1)!;

    expect(chapterOne).toMatchObject({ included: true, closed: false, summarized: false, stale: false });
    expect(earlyRow.status).toBe(`current · ${formatTokensEstimate(chapterOne.tokens).replace("~", "")} raw`);
    expect(buildRailModel(payload, "", 32_768, early).chapterNotice).toBe(null);

    const middle = estimateFor(payload, "p6");
    const chapterTwo = middle.chapters.find((chapter) => chapter.number === 2)!;
    const middleRow = chapterListModel(payload, 32_768, middle).rows
      .find((row) => row.chapter.number === 2)!;
    expect(chapterTwo).toMatchObject({ included: true, closed: false, summarized: false, stale: false });
    expect(middleRow.status).toBe(`current · ${formatTokensEstimate(chapterTwo.tokens).replace("~", "")} raw`);
  });

  test("20k parts and 100 chapters stay inside the TUI bulk-model budget", () => {
    const payload = largePayload(20_000, 100);
    const read = startTiming();
    const view = createStoryViewModel(payload);
    const model = chapterListModel(payload, 8_000, estimateFor(payload), view);
    const timing = read();
    expect(view.rows).toHaveLength(20_099);
    expect(model.rows).toHaveLength(100);
    assertWithinBudget(CONSOLE_REPORT, "20k parts and 100 chapters", BULK_MODEL_BUDGET, timing);
  }, budgetTimeout([BULK_MODEL_BUDGET]));

  test("renders 70k chapters without passing the row set as function arguments", () => {
    const state = initialState(demoAppSource(), false);
    state.payload = largePayload(70_000, 70_000);
    state.mode = "CHAPTERS";
    state.chapters = { cursor: 69_999, rename: null, deleteArmedId: null };
    const base: FrameLine[] = Array.from({ length: 24 }, () => []);
    const hits: HitRows = Array.from({ length: 24 }, () => null);
    const estimate = {
      tokens: 0,
      breakdown: { voice: 0, facts: 0, recent: 0, summary: 0, note: 0 },
      chapters: [],
      activeFactIds: [],
      droppedFacts: []
    };

    const frame = frameText(renderPanels(base, state, hits, 120, 24, estimate).lines);

    expect(frame).toContain("chapters · 70000 on this storyline");
    expect(frame).toContain("70000");
  });

  test("long TOC windows keep the cursor visible at the top, middle, and end", () => {
    expect(chapterWindow(100, 0, 20)).toEqual({ start: 0, end: 20 });
    expect(chapterWindow(100, 50, 20)).toEqual({ start: 40, end: 60 });
    expect(chapterWindow(100, 99, 20)).toEqual({ start: 80, end: 100 });
  });

  test("empty structural closing endpoints retain closed positive-savings advice", () => {
    const payload = structuredClone(createDemoController().payload());
    const prose = payload.path.find((node) => node.id === "p6")!;
    prose.text += ` ${"texture ".repeat(2_000)}`;
    payload.nodes.find((node) => node.id === prose.id)!.tokens = 2_000;
    const endpoint = payload.path.find((node) => node.id === "p10")!;
    endpoint.text = "";
    payload.nodes.find((node) => node.id === endpoint.id)!.tokens = 0;

    const estimate = estimateFor(payload);
    const chapter = estimate.chapters.find((candidate) => candidate.number === 2)!;
    expect(chapter.included).toBeTrue();
    expect(chapter.closed).toBeTrue();
    expect(chapter.savings).toBeGreaterThan(0);
  });
});

function estimateFor(payload: StoryPayload, targetId = payload.path.at(-1)?.id ?? null) {
  return nextRequestEstimate(payload, requestFor(payload, targetId));
}

function requestFor(payload: StoryPayload, targetId = payload.path.at(-1)?.id ?? null): NextRequestContext {
  return {
    systemPrompt: "Continue the story.",
    instruction: "",
    operation: "continue",
    targetId,
    assistantPrefill: true
  };
}

function largePayload(size: number, chapterCount: number): StoryPayload {
  const path: StoryNode[] = [];
  const nodes: NodeStub[] = [];
  const chapterBreaks: ChapterBreak[] = [];
  const every = Math.floor(size / chapterCount);
  for (let index = 0; index < size; index += 1) {
    const id = `p${index}`;
    const parentId = index === 0 ? null : `p${index - 1}`;
    const activeChildId = index === size - 1 ? null : `p${index + 1}`;
    path.push({ id, parentId, activeChildId, instruction: "", text: "one compact part", model: "test", createdAt: "2026-01-01" });
    nodes.push({ id, parentId, activeChildId, preview: "one compact part", words: 3, tokens: 4,
      childCount: activeChildId === null ? 0 : 1, leafCount: 1, lastTouched: "2026-01-01", hasInstruction: false });
    if ((index + 1) % every === 0 && index < size - 1) {
      chapterBreaks.push({ id: `b${chapterBreaks.length}`, parentPartId: id, title: `Chapter ${chapterBreaks.length + 2}`, createdAt: "2026-01-01" });
    }
  }
  return {
    id: "large", title: "Large", createdAt: "2026-01-01", updatedAt: "2026-01-01",
    nodes, path, activeRootId: "p0", tags: [], recentNodeIds: [], facts: [], chapterBreaks
  };
}
