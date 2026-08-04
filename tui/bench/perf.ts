/** Headless performance harness for 1667. Run: bun bench/perf.ts
 *  Budgets (from the design brief): warm re-render of a 60-part line < 16ms;
 *  everything else is tracked to catch regressions on large stories/vaults. */
import type { StoryNode, StoryPayload, StorySummary } from "../../shared/types.js";
import { createTestRenderer } from "@opentui/core/testing";
import { createStoryViewModel, resolveSwitchTarget } from "../src/model.js";
import { chapterListModel } from "../src/chapter-model.js";
import { createPathLayout, movePathCursor } from "../src/path-layout.js";
import { libraryRows, libraryTotals } from "../src/library-model.js";
import { createPalette } from "../src/palette.js";
import { renderStoryScreen } from "../src/screens/story.js";
import type { StoryScreenState } from "../src/state.js";
import { frameStyledText, sliceFrame } from "../src/screens/story/frame.js";
import { deriveStoryFrameLayout } from "../src/story-frame-layout.js";
import { createStorySurface } from "../src/story-surface.js";
import { createWrapCache, wrapText, type ProseStyle, type WrapCache } from "../src/wrap.js";
import { createComposer } from "../src/composer-model.js";
import { nextRequestEstimate } from "../src/request-projection.js";
import { createAtlasLayout } from "../src/atlas-layout.js";
import { renderMapTreeRow } from "../src/screens/map-tree-row.js";
import {
  createStoryWrapBuild,
  storyFrameWrapPlans,
  type StoryWrapBuild,
  type StoryWrapBuildStats
} from "../src/story-wrap-build.js";
import { appendStreamText, emptyStreamText } from "../src/stream-text.js";
import { createNoticeLog } from "../src/notice-log.js";

const SENTENCE_WORDS = "The lantern held its flame while the storm counted windows, and nobody in the inn below said the traveler's name aloud."
  .split(" ");

function makeParagraph(words: number): string {
  return Array.from(
    { length: words },
    (_, index) => SENTENCE_WORDS[index % SENTENCE_WORDS.length]
  ).join(" ");
}

interface SyntheticShape { parts: number; takesEvery: number; takesper: number; wordsPerPart: number }

function syntheticPayload({ parts, takesEvery, takesper, wordsPerPart }: SyntheticShape): StoryPayload {
  const nodes: StoryPayload["nodes"] = [];
  const path: StoryNode[] = [];
  let parentId: string | null = null;
  for (let index = 0; index < parts; index += 1) {
    const id = `p${index}`;
    const text = makeParagraph(wordsPerPart);
    const siblings = index > 0 && index % takesEvery === 0 ? takesper : 1;
    for (let take = 0; take < siblings; take += 1) {
      const takeId = take === 0 ? id : `${id}-t${take}`;
      nodes.push({
        id: takeId, parentId, preview: text.slice(0, 100), words: wordsPerPart,
        tokens: Math.ceil(wordsPerPart * 1.3),
        childCount: take === 0 && index < parts - 1 ? 1 : 0,
        leafCount: 1, lastTouched: "2026-07-19T00:00:00Z", hasInstruction: true,
        activeChildId: take === 0 && index < parts - 1 ? `p${index + 1}` : null
      });
    }
    path.push({
      id, parentId, instruction: `part ${index}`, text, model: "bench",
      createdAt: "2026-07-19T00:00:00Z", activeChildId: index < parts - 1 ? `p${index + 1}` : null
    });
    parentId = id;
  }
  return {
    id: "bench", title: "bench story", createdAt: "2026-07-19T00:00:00Z", updatedAt: "2026-07-19T00:00:00Z",
    nodes, path, activeRootId: "p0", tags: [], recentNodeIds: [], facts: [], chapterBreaks: []
  };
}

function wideAtlasPayload(branches: number): StoryPayload {
  const nodes: StoryPayload["nodes"] = [];
  const tags: StoryPayload["tags"] = [];
  for (let index = 0; index < branches; index += 1) {
    const root = `root-${index}`;
    const leaf = `leaf-${index}`;
    nodes.push(
      {
        id: root, parentId: null, preview: root, words: 1, tokens: 1,
        childCount: 1, leafCount: 1, lastTouched: "2026-07-19T00:00:00Z",
        hasInstruction: false, activeChildId: index === 0 ? leaf : null
      },
      {
        id: leaf, parentId: root, preview: leaf, words: 1, tokens: 1,
        childCount: 0, leafCount: 1, lastTouched: "2026-07-19T00:00:00Z",
        hasInstruction: false, activeChildId: null
      }
    );
    tags.push({
      nodeId: leaf, name: leaf, label: "Canon", color: "", createdAt: "2026-07-19T00:00:00Z"
    });
  }
  const firstRoot = nodes[0]!;
  const firstLeaf = nodes[1]!;
  return {
    id: "wide-atlas", title: "wide atlas", createdAt: "2026-07-19T00:00:00Z",
    updatedAt: "2026-07-19T00:00:00Z", nodes,
    path: [firstRoot, firstLeaf].map((node): StoryNode => ({
      id: node.id, parentId: node.parentId, instruction: "", text: node.preview,
      model: "bench", createdAt: node.lastTouched, activeChildId: node.activeChildId
    })),
    activeRootId: firstRoot.id, tags, recentNodeIds: [], facts: [], chapterBreaks: []
  };
}

function deepAtlasPayload(depth: number): StoryPayload {
  const touched = "2026-07-22T00:00:00Z";
  const nodes: StoryPayload["nodes"] = [];
  const path: StoryNode[] = [];
  const tags: StoryPayload["tags"] = [];
  for (let index = 0; index < depth; index += 1) {
    const id = `trunk-${index}`;
    const parentId = index === 0 ? null : `trunk-${index - 1}`;
    const activeChildId = index + 1 < depth ? `trunk-${index + 1}` : null;
    nodes.push({
      id, parentId, preview: id, words: 1, tokens: 1,
      childCount: activeChildId === null ? 0 : 2, leafCount: depth - index,
      lastTouched: touched, hasInstruction: false, activeChildId
    });
    path.push({
      id, parentId, instruction: "", text: id, model: "bench",
      createdAt: touched, activeChildId
    });
    if (activeChildId === null) continue;
    const sideId = `side-${index}`;
    nodes.push({
      id: sideId, parentId: id, preview: sideId, words: 1, tokens: 1,
      childCount: 0, leafCount: 1, lastTouched: touched,
      hasInstruction: false, activeChildId: null
    });
    tags.push({
      nodeId: sideId, name: sideId, label: "Canon", color: "", createdAt: touched
    });
  }
  return {
    id: "deep-atlas", title: "deep atlas", createdAt: touched, updatedAt: touched,
    nodes, path, activeRootId: path[0]?.id ?? null, tags,
    recentNodeIds: [], facts: [], chapterBreaks: []
  };
}

function stateFor(payload: StoryPayload): StoryScreenState {
  return {
    payload, focusIndex: payload.path.length - 1, mode: "NAV", showInstructions: true,
    expandedPromptIds: new Set(),
    composer: createComposer(), editor: null, retakePrompt: null, request: null, probs: null,
    toast: null, notices: createNoticeLog(), stream: null, abort: null, backendTask: null,
    freshLandedAt: new Map(), now: 1_667_000_000_000,
    model: "bench", systemPrompt: "Continue the story.", assistantPrefill: true,
    contextWindow: 32768, maxTokens: 1024,
    map: null, search: null, contextMeterExpanded: false, prune: null, tag: null, typewriter: false,
    expandedChapterSummaryIds: new Set(), chapterDeleteArmedId: null,
    demo: true, storyFolder: "", readingPositions: {},
    library: null, facts: null, commands: null, card: null, archive: null,
    chapters: null, settings: null, summary: null,
    actions: null, textActions: null, hitRows: [],
    viewScroll: null, viewScrollDelta: 0, lastViewportStart: 0,
    composerScrollTop: 0, editorScrollTop: 0, keysScrollTop: 0,
    composerSelectionProjection: null, storySelectionProjection: null,
    promptTokenCount: null, generationRoute: "bench",
    config: {
      theme: "lantern", factsRail: "auto", composeFocus: "off", composeMaxHeight: null,
      quota: { date: "", words: 0 },
      updates: { mode: "notify", channel: "stable", skippedVersion: null }
    },
    connection: { down: false, attempt: 0, nextRetryAt: null, error: null }
  };
}

interface BenchRow {
  label: string;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  budgetMs: number | null;
  pass: boolean;
}

interface ColdBuildMeasurement {
  stats: StoryWrapBuildStats;
  controlLatencyMs: number;
}

function measuredRow(label: string, budgetMs: number | null, samples: readonly number[]): BenchRow {
  const sorted = [...samples].sort((left, right) => left - right);
  const percentile = (value: number) => sorted[Math.max(0, Math.ceil(sorted.length * value) - 1)] ?? 0;
  const p95Ms = percentile(0.95);
  return {
    label,
    p50Ms: percentile(0.5),
    p95Ms,
    maxMs: sorted.at(-1) ?? 0,
    budgetMs,
    pass: budgetMs === null || p95Ms <= budgetMs
  };
}

function time(label: string, budgetMs: number | null, run: () => void, iterations = 10): BenchRow {
  run(); // warm once
  const samples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    run();
    samples.push(performance.now() - started);
  }
  return measuredRow(label, budgetMs, samples);
}

async function coldBuildStats(
  state: StoryScreenState,
  width: number
): Promise<ColdBuildMeasurement> {
  const layout = deriveStoryFrameLayout(width, state.config);
  const cache = createWrapCache<"human">();
  let build: StoryWrapBuild;
  const startedAt = performance.now();
  let controlLatencyMs: number | null = null;
  return await new Promise<ColdBuildMeasurement>((resolve, reject) => {
    build = createStoryWrapBuild(cache, {
      clock: {
        now: () => performance.now(),
        yield(callback) {
          setTimeout(() => {
            controlLatencyMs ??= performance.now() - startedAt;
            callback();
          }, 0);
        }
      },
      onReady: () => {
        const stats = build.stats();
        build.dispose();
        resolve({ stats, controlLatencyMs: controlLatencyMs ?? 0 });
      },
      onError: reject
    });
    if (build.ensure(state, layout) === "ready") {
      const stats = build.stats();
      build.dispose();
      resolve({ stats, controlLatencyMs: 0 });
    }
  });
}

async function appendBuildLatency(
  state: StoryScreenState,
  width: number,
  cache: WrapCache<ProseStyle>
): Promise<number> {
  const layout = deriveStoryFrameLayout(width, state.config);
  const startedAt = performance.now();
  let build: StoryWrapBuild;
  let settled = false;
  return await new Promise<number>((resolve, reject) => {
    const finish = () => {
      if (settled) return;
      settled = true;
      build.dispose();
      resolve(performance.now() - startedAt);
    };
    build = createStoryWrapBuild(cache, {
      onReady: finish,
      onError(error) {
        if (settled) return;
        settled = true;
        build.dispose();
        reject(error);
      }
    });
    if (build.ensure(state, layout) === "ready") finish();
  });
}

const rows: BenchRow[] = [];

// 1 · The brief's explicit budget: 60-part line, warm wrap cache, full repaint.
{
  const payload = syntheticPayload({ parts: 60, takesEvery: 5, takesper: 4, wordsPerPart: 120 });
  const state = stateFor(payload);
  const cache = createWrapCache<"human">();
  renderStoryScreen(state, { width: 120, height: 36, wrapCache: cache });
  rows.push(time("repaint 60-part line (warm cache)", 16, () => renderStoryScreen(state, { width: 120, height: 36, wrapCache: cache }), 50));
}

// 2 · Large story: 500 parts.
{
  const payload = syntheticPayload({ parts: 500, takesEvery: 7, takesper: 6, wordsPerPart: 150 });
  const state = stateFor(payload);
  const cache = createWrapCache<"human">();
  rows.push(time("cold full wrap+repaint 500-part line (75k words)", null, () => {
    cache.invalidate();
    renderStoryScreen(state, { width: 120, height: 36, wrapCache: cache });
  }, 3));
  const coldRuns: ColdBuildMeasurement[] = [];
  for (let run = 0; run < 5; run += 1) coldRuns.push(await coldBuildStats(state, 120));
  rows.push(measuredRow(
    "cold prose work slice, 500 parts / 75k words",
    8,
    coldRuns.flatMap(({ stats }) => stats.sliceSamplesMs)
  ));
  rows.push(measuredRow(
    "control callback during cold prose build",
    50,
    coldRuns.map(({ controlLatencyMs }) => controlLatencyMs)
  ));
  state.mode = "COMPOSE";
  state.composer.fullscreen = true;
  rows.push(time("fullscreen compose repaint, 500 parts / cold prose cache", 16, () => {
    cache.invalidate();
    renderStoryScreen(state, { width: 120, height: 36, wrapCache: cache });
  }, 20));
  state.mode = "NAV";
  state.composer.fullscreen = false;
  renderStoryScreen(state, { width: 120, height: 36, wrapCache: cache });
  rows.push(time("repaint 500-part line (warm cache)", 16, () => renderStoryScreen(state, { width: 120, height: 36, wrapCache: cache }), 20));
  rows.push(time("streaming delta repaint on 500-part line", 16, () => {
    cache.invalidate("p499");
    renderStoryScreen(state, { width: 120, height: 36, wrapCache: cache });
  }, 20));
  // The real interactive path: a live append stream is SET on the state, so
  // every repaint walks projection → story index → wrap. Each iteration lands
  // one delta batch, exactly like a generation frame.
  {
    const streamTarget = payload.path.at(-1)!;
    state.stream = {
      targetId: streamTarget.id,
      parentId: streamTarget.parentId,
      append: true,
      startedAt: "2026-07-23T00:00:00Z",
      instruction: "",
      ...emptyStreamText()
    };
    let delta = 0;
    rows.push(time("live-stream delta repaint on 500-part line", 16, () => {
      delta += 1;
      appendStreamText(state.stream!, ` and the stream landed delta ${delta} of the take`);
      renderStoryScreen(state, { width: 120, height: 36, wrapCache: cache });
    }, 20));
    // Later rows render at other widths only; the settled state needs no rewarm.
    state.stream = null;
  }
  rows.push(time("view model rebuild, 500 parts", 8, () => createStoryViewModel(payload), 20));
  rows.push(time("switch-target resolve on 500-part payload", 4, () => resolveSwitchTarget(payload, "p350", 1), 50));

  const layout = deriveStoryFrameLayout(150, state.config);
  const wideFrame = renderStoryScreen(state, { width: 150, height: 36, wrapCache: cache, layout });
  const palette = createPalette("lantern", "256");
  rows.push(time("wide frame split + styled-text conversion", 8, () => {
    frameStyledText(sliceFrame(wideFrame.lines, 0, layout.pageWidth), palette);
    frameStyledText(sliceFrame(wideFrame.lines, layout.railStart!, layout.fullWidth - layout.railStart!), palette);
  }, 50));
  const setup = await createTestRenderer({ width: 150, height: 36 });
  const surface = createStorySurface(setup.renderer, palette);
  surface.paint(wideFrame.lines, palette, layout, wideFrame.selectable);
  let repaintFocus = state.focusIndex;
  const repaintWideSurface = () => {
    repaintFocus = repaintFocus === 499 ? 498 : 499;
    state.focusIndex = repaintFocus;
    const frame = renderStoryScreen(state, { width: 150, height: 36, wrapCache: cache, layout });
    surface.paint(frame.lines, palette, layout, frame.selectable);
  };
  // Measure steady-state p95 after Bun has optimized the wide split/native
  // buffer path; cold and first-load costs have separate rows above.
  for (let index = 0; index < 10; index += 1) repaintWideSurface();
  rows.push(time("full wide surface repaint 500-part line", 16, repaintWideSurface, 50));
  let scrollStart = 0;
  rows.push(time("wide wheel-scroll surface repaint", 16, () => {
    scrollStart = scrollStart === 0 ? 8 : 0;
    state.viewScroll = scrollStart;
    const frame = renderStoryScreen(state, { width: 150, height: 36, wrapCache: cache, layout });
    surface.paint(frame.lines, palette, layout, frame.selectable);
  }, 20));
  setup.renderer.destroy();
}

// 3 · Monster single paragraph (wrap engine worst case).
{
  const text = makeParagraph(10_000);
  rows.push(time("wrap one 10k-word paragraph at 72ch", 50, () => wrapText(text, [], 72), 5));
}

// 3b · Sustained append streaming reuses the prior exact wrapped prefix.
{
  const state = stateFor(syntheticPayload({
    parts: 1,
    takesEvery: 2,
    takesper: 1,
    wordsPerPart: 25_000
  }));
  const cache = createWrapCache<ProseStyle>();
  const layout = deriveStoryFrameLayout(120, state.config);
  const [settled] = storyFrameWrapPlans(state, layout);
  cache.wrap(
    settled!.partId,
    settled!.width,
    settled!.text,
    settled!.runs,
    settled!.identity
  );
  const node = state.payload.path[0]!;
  state.stream = {
    targetId: node.id,
    parentId: node.parentId,
    append: true,
    startedAt: "2026-07-23T00:00:00Z",
    instruction: "",
    ...emptyStreamText()
  };
  const prewarmSamples: number[] = [];
  const frameSamples: number[] = [];
  const palette = createPalette("lantern", "256");
  const setup = await createTestRenderer({ width: 120, height: 36 });
  const surface = createStorySurface(setup.renderer, palette);
  for (let index = 0; index < 20; index += 1) {
    appendStreamText(state.stream, ` next${index}`);
    prewarmSamples.push(await appendBuildLatency(state, 120, cache));
    const startedAt = performance.now();
    const frame = renderStoryScreen(state, {
      width: 120,
      height: 36,
      wrapCache: cache,
      layout
    });
    surface.paint(frame.lines, palette, layout, frame.selectable);
    frameSamples.push(performance.now() - startedAt);
  }
  setup.renderer.destroy();
  rows.push(measuredRow(
    "append prewarm from warm 25k-word part",
    16,
    prewarmSamples
  ));
  rows.push(measuredRow(
    "append final frame+surface, warm 25k-word part",
    16,
    frameSamples
  ));
}

// 4 · Deep/wide loom: 2000 nodes, piles of 24 takes.
{
  const payload = syntheticPayload({ parts: 200, takesEvery: 2, takesper: 20, wordsPerPart: 40 });
  rows.push(time(`loom layout on ${payload.nodes.length}-node tree`, 8, () => createPathLayout(payload, "p100", 24), 20));
  rows.push(time("loom cursor move on big tree", 4, () => movePathCursor(payload, "p100", 1, 0), 50));
}

// 4b · High-fanout atlas: topology must stay linear and paint only the window.
{
  const payload = wideAtlasPayload(1_600);
  rows.push(time("atlas layout+visible paint, 1.6k branches", 100, () => {
    const layout = createAtlasLayout(payload, { now: Date.parse("2026-07-22T00:00:00Z"), maxRows: 30 });
    for (const row of layout.rows) renderMapTreeRow(row, 120, null);
  }, 5));
}

// 4c · Deep forked atlas: traversal stays iterative at the 20k-node scale.
{
  const payload = deepAtlasPayload(10_000);
  rows.push(time("atlas layout, 19,999 nodes / 10k depth", 300, () => {
    const layout = createAtlasLayout(payload, { now: Date.parse("2026-07-22T00:00:00Z"), maxRows: 30 });
    if (layout.totalRows !== 19_999) throw new Error(`Deep atlas lost rows: ${layout.totalRows}`);
  }, 3));
}

// 5 · Vault of 200 stories: library rows + totals + fuzzy.
{
  const stories: StorySummary[] = Array.from({ length: 200 }, (_, index) => ({
    id: `s${index}`, title: `story about the ${index % 2 === 0 ? "lantern" : "orchard"} ${index}`,
    updatedAt: "2026-07-19T00:00:00Z", partCount: 40 + index, words: 8_000 + index * 13, forked: index % 3 === 0, lineCount: 3
  }));
  rows.push(time("library rows+totals, 200 stories, no query", 4, () => { libraryRows(stories, ""); libraryTotals(stories); }, 50));
  rows.push(time("library fuzzy filter, 200 stories", 4, () => libraryRows(stories, "lantern 1"), 50));
}

// 6 · Chapter projection: 20k parts / 100 chapters, no prose loads beyond the
// already-active line. Matches Plan 010's largest supported structural shape.
{
  const payload = syntheticPayload({ parts: 20_000, takesEvery: 20_001, takesper: 1, wordsPerPart: 3 });
  for (let index = 199; index < payload.path.length - 1; index += 200) {
    payload.chapterBreaks.push({
      id: `chapter-${payload.chapterBreaks.length + 1}`,
      parentPartId: payload.path[index]!.id,
      title: `Chapter ${payload.chapterBreaks.length + 2}`,
      createdAt: "2026-07-19T00:00:00Z"
    });
  }
  rows.push(time("chapter rows+overlay, 20k parts / 100 chapters", 300, () => {
    const view = createStoryViewModel(payload);
    const estimate = nextRequestEstimate(payload, {
      systemPrompt: "Continue the story.", instruction: "",
      operation: "continue", targetId: payload.path.at(-1)?.id ?? null, assistantPrefill: true
    });
    chapterListModel(payload, 8_000, estimate, view);
  }, 3));
}

const width = Math.max(...rows.map((row) => row.label.length)) + 2;
for (const row of rows) {
  const budget = row.budgetMs === null ? "     —" : `${row.budgetMs.toString().padStart(4)}ms`;
  process.stdout.write(
    `${row.pass ? "ok  " : "FAIL"} ${row.label.padEnd(width)}`
    + ` p50 ${row.p50Ms.toFixed(2).padStart(7)}ms`
    + `  p95 ${row.p95Ms.toFixed(2).padStart(7)}ms`
    + `  max ${row.maxMs.toFixed(2).padStart(7)}ms`
    + `  budget ${budget}\n`
  );
}
if (rows.some((row) => !row.pass)) process.exit(1);
