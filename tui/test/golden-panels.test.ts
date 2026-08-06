import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { handleKey, initialState, renderOnce } from "../src/app.js";
import { createDemoController, demoAppSource, demoStoryApi, DEMO_SETTINGS_DOCUMENT } from "../src/demo.js";
import { createStoryViewModel, rowIndexForNode } from "../src/model.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText } from "../src/screens/story/frame.js";
import { cellWidth } from "../src/cell-width.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";
import { createTokenProbabilities } from "../../shared/token-probabilities.js";
import type { SettingsPresetV2, SettingsProtocolV2, SettingsView } from "../../shared/settings-v2-types.js";
import { dryRunProbabilityStep } from "../../server/token-probability-capture.js";

function key(name: string, sequence = name): KeyEvent {
  return { name, sequence, shift: false, ctrl: false, meta: false } as KeyEvent;
}

async function renderWithKeys(
  source: ReturnType<typeof demoAppSource>,
  width: number,
  height: number,
  keys: readonly KeyEvent[]
): Promise<string> {
  const state = initialState(source, true);
  const cache = createWrapCache<ProseStyle>();
  const cancelStream = async () => {
    state.stream = null;
    state.abort = null;
  };
  for (const event of keys) {
    await handleKey(event, state, source, cache, () => {}, cancelStream, () => {});
  }
  return frameText(renderStoryScreen(state, { width, height, wrapCache: cache }).lines);
}

function lineContaining(frame: string, text: string): string {
  const line = frame.split("\n").find((candidate) => candidate.includes(text));
  expect(line).toBeDefined();
  return line!;
}

/** The token probability viewer's column header, not its title line — both
 *  contain the substring "logprob" ("logprobs · top N" vs. the "logprob"
 *  column label), so a plain `lineContaining` finds whichever comes first.
 *  Only the title line ever says "top". */
function columnHeaderLine(frame: string): string {
  const line = frame.split("\n").find((candidate) =>
    candidate.includes("logprob") && !candidate.includes("top"));
  expect(line).toBeDefined();
  return line!;
}

function cellColumn(line: string, text: string, from = 0): number {
  const index = line.indexOf(text, from);
  expect(index >= 0).toBeTrue();
  return cellWidth(line.slice(0, index));
}

function expectNarrowPanelRowsBounded(frame: string): void {
  for (const line of frame.split("\n").filter((candidate) => candidate.includes("┃"))) {
    // 80 cols: panel starts at 4, its 72-cell surface ends before column 76.
    expect(cellWidth(line.trimEnd()) <= 76).toBeTrue();
  }
}

describe("run C overlay frames", () => {
  test("library aligns columns and shows totals without a folder blank", async () => {
    const frame = await renderOnce(demoAppSource(), 120, 36, "o");
    expect(frame).toContain("┏━ library · 4 stories ·");
    expect(frame).not.toContain("library ·  ·");
    expect(frame).toMatch(/title\s+words {2}structure\s+updated/);
    expect(frame).toContain("▸ the lantern keeper");
    expect(frame).toMatch(/23 parts · 11 lines\s+\S/);
    expect(frame).not.toContain("lines359y");
    expect(frame).toContain("LIBRARY");
  });

  test("facts overlay shows chips, columns, and footer", async () => {
    const frame = await renderOnce(demoAppSource(), 120, 36, "f");
    expect(frame).toContain("┏━ facts · 5 notes");
    expect(frame).toContain("[ all ]");
    expect(frame).toContain("d delete");
    expect(frame).toContain("FACTS");

    const compact = await renderOnce(demoAppSource(), 80, 24, "f");
    const maren = lineContaining(compact, "▸ Maren");
    // The closed frame spends two cells on its right edge and margin, so the
    // note column ends two characters earlier than it did open-sided.
    expect(maren).toContain("Keeps th…always");
    expect(maren.match(/Maren/g)).toHaveLength(1);

    const activated = demoAppSource();
    activated.payload = {
      ...activated.payload,
      facts: activated.payload.facts.map((fact, index) => index < 2
        ? {
            ...fact,
            activation: "keyed" as const,
            keys: [index === 0 ? "Maren" : "never-match-key"]
          }
        : fact)
    };
    const activationFrame = await renderWithKeys(activated, 120, 36, [key("f")]);
    expect(activationFrame).toContain("facts · 5 notes · 1/2 keyed");
    expect(lineContaining(activationFrame, "▸ Maren")).toContain("✓ keyed");
    expect(lineContaining(activationFrame, "· keyed")).toContain("Ashe");
  });

  test("card import panel keeps its field, candidates, and error in the panel surface", () => {
    const state = initialState(demoAppSource(), true);
    state.mode = "CARD";
    state.card = {
      path: "~/cards/mira",
      storyId: state.payload.id,
      candidates: [],
      error: null,
      returnMode: "NAV"
    };
    const card = state.card;
    const rest = frameText(renderStoryScreen(state, {
      width: 120, height: 36, wrapCache: createWrapCache()
    }).lines);
    expect(rest).toContain("┏━ import character card ━");
    expect(rest).toContain("card    ~/cards/mira█");
    expect(rest).toContain("tab completes · ↵ imports · esc closes");
    expect(rest).toContain(" CARD ");

    card.candidates = ["mira-notes/", "mira-one.json", "mira-two.json"];
    const candidates = frameText(renderStoryScreen(state, {
      width: 120, height: 36, wrapCache: createWrapCache()
    }).lines);
    expect(candidates).toContain("mira-notes/");
    expect(candidates).toContain("mira-one.json");
    expect(candidates).toContain("mira-two.json");

    card.candidates = [];
    card.error = "Character Card V3 is not supported yet; export a V2 PNG or JSON card.";
    const error = frameText(renderStoryScreen(state, {
      width: 120, height: 36, wrapCache: createWrapCache()
    }).lines);
    expect(error).toContain("· Character Card V3 is not supported yet;");
    expect(error).toContain("export a V2 PNG");
    expect(error).toContain("or JSON card.");
  });

  test("archive import panel matches the resting design frame", () => {
    const state = initialState(demoAppSource(), true);
    state.mode = "ARCHIVE";
    state.archive = {
      path: "",
      storyId: state.payload.id,
      candidates: [],
      error: null,
      returnMode: "NAV"
    };
    const rest = frameText(renderStoryScreen(state, {
      width: 120, height: 36, wrapCache: createWrapCache()
    }).lines);

    expect(rest).toContain("┏━ import archive ━");
    expect(rest).toContain("file    █");
    expect(rest).toContain(
      ".lorebook .json → Facts · .scenario .story → new story"
    );
    expect(rest).toContain("tab completes · ↵ imports · esc closes");
    expect(rest).toContain(" ARCHIVE ");
  });

  test("long library, facts, and tag lists keep the selected row visible", () => {
    const selected = 20;
    const render = (state: ReturnType<typeof initialState>) => {
      const frame = renderStoryScreen(state, { width: 80, height: 24, wrapCache: createWrapCache() });
      return { text: frameText(frame.lines), hits: frame.derived.hitRows };
    };
    const hasSelectedHit = (hits: ReturnType<typeof render>["hits"]) => hits.some((row) =>
      row?.target.kind === "list" && row.target.index === selected
      || row?.overrides?.some((hit) => hit.target.kind === "list" && hit.target.index === selected) === true
    );

    const libraryState = initialState(demoAppSource(), true);
    const story = libraryState.library?.stories[0] ?? demoAppSource().stories[0]!;
    const stories = Array.from({ length: 25 }, (_, index) => ({
      ...story, id: `story-${index + 1}`, title: `story ${String(index + 1).padStart(2, "0")}`
    }));
    libraryState.mode = "LIBRARY";
    libraryState.library = { stories, cursor: selected, query: "", prompt: null };
    const library = render(libraryState);
    expect(library.text).toContain("7–21/25");
    expect(library.text).toContain("▸ story 21");
    expect(hasSelectedHit(library.hits)).toBeTrue();

    const factsState = initialState(demoAppSource(), true);
    const fact = factsState.payload.facts[0]!;
    factsState.payload.facts = Array.from({ length: 25 }, (_, index) => ({
      ...fact, id: `fact-${index + 1}`, text: `Fact ${String(index + 1).padStart(2, "0")}\nbody`, tag: "test"
    }));
    factsState.mode = "FACTS";
    factsState.facts = { cursor: selected, query: "", chip: 0, selectedTag: null, filtering: false, deleteArmedId: null };
    const facts = render(factsState);
    expect(facts.text).toContain("8–21/25");
    expect(facts.text).toContain("▸ Fact 21");
    expect(hasSelectedHit(facts.hits)).toBeTrue();

    const tagsState = initialState(demoAppSource(), true);
    const tag = tagsState.payload.tags[0]!;
    tagsState.payload.tags = Array.from({ length: 25 }, (_, index) => ({
      ...tag, name: `mark ${String(index + 1).padStart(2, "0")}`
    }));
    tagsState.mode = "COMMANDS";
    tagsState.commands = {
      cursor: selected, selectedId: null, query: "", view: "tags", returnMode: "NAV"
    };
    const tags = render(tagsState);
    expect(tags.text).toContain("7–21/25");
    expect(tags.text).toContain("▸ mark 21");
    expect(hasSelectedHit(tags.hits)).toBeTrue();
  });

  test("command palette groups actions and fuzzy-filters with a live Search field", async () => {
    // Height 40, not 36: the Story section now carries the Author Brief and
    // Facts budget commands alongside the Author's Note, so the unfiltered
    // palette is taller than it was and needs the extra rows to reach the
    // System section without scrolling.
    const grouped = await renderOnce(demoAppSource(), 120, 40, ":");
    expect(grouped).toContain("┏━ commands ━");
    expect(grouped).toContain("Search");
    const sectionOffsets = ["Suggested", "Story", "Take", "View", "System"]
      .map((section) => grouped.indexOf(section));
    expect(sectionOffsets.every((offset) => offset >= 0)).toBeTrue();
    expect(sectionOffsets).toEqual([...sectionOffsets].sort((left, right) => left - right));
    expect(grouped).toContain("tag this line");
    expect(grouped).toContain("direct take");
    expect(grouped).toContain("generation settings");
    expect(grouped).not.toContain("acknowledge unknown");
    expect(grouped).toContain("theme: lantern");
    expect(grouped).toContain("↑↓ move · ↵ run · esc close");

    const filtered = await renderOnce(demoAppSource(), 120, 36, ":sum");
    expect(filtered).toContain("Search  sum");
    expect(filtered).toContain("Take");
    expect(filtered).toContain("summary take");
    expect(filtered).toContain("compress the current prefix");
    expect(filtered).not.toContain("Story");
    expect(filtered).toContain("COMMANDS");
  });

  test("long command queries tail-truncate inside the panel and retain the block cursor", () => {
    const state = initialState(demoAppSource(), true);
    state.mode = "COMMANDS";
    state.commands = {
      query: `${"0123456789".repeat(20)}TAIL`, cursor: 0, selectedId: null,
      view: "commands", returnMode: "NAV"
    };
    const rendered = renderStoryScreen(state, { width: 80, height: 24, wrapCache: createWrapCache() });
    const text = frameText(rendered.lines);
    const search = rendered.lines.find((line) => line.some((part) => part.text.includes("Search")));

    expect(search).toBeDefined();
    expect(search!.some((part) => part.background === "focus / accent")).toBeTrue();
    expect(search!.map((part) => part.text).join("")).toContain("TAIL");
    expectNarrowPanelRowsBounded(text);
  });

  test("facts filtering clamps a stale cursor to the selected visible row", () => {
    const state = initialState(demoAppSource(), true);
    const fact = state.payload.facts[0]!;
    state.payload.facts = Array.from({ length: 25 }, (_, index) => ({
      ...fact, id: `fact-${index + 1}`, text: `Fact ${String(index + 1).padStart(2, "0")}\nbody`, tag: "test"
    }));
    state.mode = "FACTS";
    state.facts = {
      cursor: 20, query: "Fact 03", chip: 0, selectedTag: null, filtering: true, deleteArmedId: null
    };
    const rendered = renderStoryScreen(state, { width: 80, height: 24, wrapCache: createWrapCache() });
    const text = frameText(rendered.lines);

    expect(text).toContain("▸ Fact 03");
    expect(rendered.derived.hitRows.some((row) =>
      row?.target.kind === "list" && row.target.index === 0
      || row?.overrides?.some((hit) => hit.target.kind === "list" && hit.target.index === 0) === true
    )).toBeTrue();
  });

  test("the Facts panel tells a shed Fact apart from one that never matched or one that was sent", () => {
    // Review finding D: activeFactIds used to mean only "activation matched",
    // so a Fact the budget shed rendered identically to one that never
    // matched at all, and an always Fact ranked low that was shed rendered
    // identically to one actually being sent. Both are reproduced here.
    const state = initialState(demoAppSource(), true);
    const now = state.payload.facts[0]!.createdAt;
    const alwaysSent = {
      id: "always-sent", tag: null, text: "Always sent fact.",
      activation: "always" as const, keys: [], createdAt: now, updatedAt: now
    };
    const alwaysShed = {
      id: "always-shed", tag: null, text: "Always fact ranked low, shed by the tight budget.",
      activation: "always" as const, keys: [], priority: "low" as const, createdAt: now, updatedAt: now
    };
    const keyedDormant = {
      id: "keyed-dormant", tag: null, text: "Keyed fact whose key never appears.",
      activation: "keyed" as const, keys: ["zzz-never-matches-zzz"], createdAt: now, updatedAt: now
    };
    const keyedShed = {
      id: "keyed-shed", tag: null, text: "Keyed fact whose key matches, shed by the tight budget.",
      activation: "keyed" as const, keys: ["Maren"], priority: "low" as const, createdAt: now, updatedAt: now
    };
    state.payload.facts = [alwaysSent, alwaysShed, keyedDormant, keyedShed];
    // Room for exactly the one Fact that must stay: alwaysSent is exempt from
    // shedding, so the budget alone decides the other three.
    state.payload.factsBudgetTokens = 1;
    state.mode = "FACTS";
    state.facts = { cursor: 0, query: "", chip: 0, selectedTag: null, filtering: false, deleteArmedId: null };
    const text = frameText(renderStoryScreen(state, { width: 100, height: 30, wrapCache: createWrapCache() }).lines);
    const lineFor = (name: string) => lineContaining(text, name);

    const alwaysSentLine = lineFor("Always sent fact");
    const alwaysShedLine = lineFor("Always fact ranked low");
    const keyedDormantLine = lineFor("Keyed fact whose key never");
    const keyedShedLine = lineFor("Keyed fact whose key matches");

    // An always Fact that is actually sent reads plain "always"; the shed
    // always Fact must not read the same way — it reads "✕ always".
    expect(alwaysSentLine).toContain("always");
    expect(alwaysSentLine).not.toContain("✕ always");
    expect(alwaysShedLine).toContain("✕ always");
    // A keyed Fact that never matched reads "· keyed"; the keyed Fact whose
    // key did match but was then shed reads "✕ keyed" instead — neither the
    // dormant marker nor the "✓ keyed" a Fact that made it into the request
    // would show.
    expect(keyedDormantLine).toContain("· keyed");
    expect(keyedShedLine).toContain("✕ keyed");
    expect(keyedShedLine).not.toContain("· keyed");
    expect(keyedShedLine).not.toContain("✓ keyed");
  });

  test("settings overlay shows theme switcher and editable fields", async () => {
    const frame = await renderOnce(demoAppSource(), 120, 36, ",");
    expect(frame).toContain("┏━ settings ━");
    expect(frame).toContain("‹ lantern ›");
    expect(frame).toContain("provider");
    expect(frame).toContain("↑↓ move · ←→ choose · ↵ next · s save");
    expect(frame).toContain("SETTINGS");
  });

  test("settings show only actionable draft state", async () => {
    const clean = await renderOnce(demoAppSource(), 120, 36, ",");
    expect(clean).not.toContain("revision");

    const dirty = await renderWithKeys(demoAppSource(), 120, 36, [
      key(","),
      key("down"),
      key("down"),
      key("right")
    ]);
    expect(dirty).toContain("● unsaved draft · s saves");
    expect(dirty).not.toContain("revision");
  });

  test("a pending restart moves no settings row", async () => {
    // The panel is centred on its content, so a taller status variant lifts the
    // panel and takes every field with it. The old mid-panel position hid this
    // for the fields below it — the extra line pushed them back down by the row
    // the lift took away — and moved the pinned rows above it instead.
    const rowsFor = async (pendingRevision: number | null): Promise<Record<string, number>> => {
      const source = demoAppSource();
      const view = { ...source.settingsView, pendingRevision, activeRevision: 3 };
      source.settingsView = view as typeof source.settingsView;
      source.api.getSettings = async () => view as typeof source.settingsView;
      const lines = (await renderOnce(source, 120, 40, ",")).split("\n");
      const rowOf = (text: string): number => lines.findIndex((line) => line.includes(text));
      return { theme: rowOf("theme"), provider: rowOf("provider"), prompt: rowOf("system ") };
    };

    const active = await rowsFor(null);
    expect(Object.values(active).every((row) => row > -1)).toBeTrue();
    expect(await rowsFor(4)).toEqual(active);
  });

  test("format-1 settings render a read-only migration banner", async () => {
    const source = demoAppSource();
    const legacy = {
      dataFormat: 1 as const,
      editable: false as const,
      stateGeneration: null,
      activeRevision: null,
      pendingRevision: null,
      document: null,
      effective: source.settings,
      effectiveProse: source.settings,
      lastActivationOutcome: null
    };
    source.settingsView = legacy;
    source.api.getSettings = async () => legacy;

    const frame = await renderOnce(source, 120, 36, ",");
    expect(frame).toContain("legacy data format 1");
    expect(frame).toContain("read-only until migration");
    // This one stays above the fields. It is a precondition for every row under
    // it, and a read-only warning met after the rows arrives too late.
    const lines = frame.split("\n");
    expect(lines.findIndex((line) => line.includes("legacy data format 1")))
      .toBeLessThan(lines.findIndex((line) => line.includes("provider")));
  });

  test("a startup rollback shows its outcome instead of a silent success line", async () => {
    const source = demoAppSource();
    if (!source.settingsView.editable) throw new Error("demo settings must be editable");
    source.settingsView = {
      ...source.settingsView,
      stateGeneration: 6,
      lastActivationOutcome: {
        transactionId: "m1.0000000000000.00000000000000000000000000000000",
        candidateRevision: 2,
        result: "rolled-back",
        errorCode: "readiness_failed",
        atStateGeneration: 6
      }
    };
    source.api.getSettings = async () => source.settingsView;

    const frame = await renderOnce(source, 120, 36, ",");
    expect(frame).toContain("saved settings did not activate");
    expect(frame).toContain("rolled back after an interruption");
    expect(frame).toContain("previous settings still active");
    expect(frame).not.toContain("revision");
  });

  test("facts rail frames context honestly as the next request; F folds it", async () => {
    const frame = await renderOnce(demoAppSource(), 150, 30);
    expect(frame).toContain("│");
    expect(frame).toContain("facts · 5 ───────────────────────");
    expect(frame).toContain("next request  ~884 / 32.8k");
    expect(frame).not.toContain("+≤");
    expect(frame).toContain(`▮${"▮".repeat(19)}   31.9k free`);
    // A gauge is not a quota readout: no percentage anywhere on the rail.
    expect(/\d+%/.test(frame)).toBeFalse();
    expect(frame).not.toContain("1,667");
    const folded = await renderOnce(demoAppSource(), 150, 30, "F");
    expect(folded).not.toContain("facts · 5");
  });

  test("facts rail never invents a percentage when the context window is unknown", async () => {
    const source = demoAppSource();
    source.settings = { ...source.settings, contextWindow: null };
    source.settingsView = {
      ...source.settingsView,
      effective: source.settings,
      effectiveProse: source.settings
    };
    const frame = await renderOnce(source, 150, 30);
    expect(frame).toContain("next request  ~884 tokens");
    expect(frame).not.toContain("+≤");
    expect(frame).toContain("set context window · settings (,)");
    expect(frame).not.toContain("free");
    expect(/\d+%/.test(frame)).toBeFalse();
  });

  test("status bar names the current line", async () => {
    const frame = await renderOnce(demoAppSource(), 120, 36);
    expect(frame).toContain("⚑ canon-storm");
  });

  test("offline NAV hint reserves the complete retry action", () => {
    for (const [width, height] of [[80, 24], [120, 36]] as const) {
      const state = initialState(demoAppSource(), true);
      state.connection = { ...state.connection, down: true, error: "offline" };
      const frame = renderStoryScreen(state, { width, height, wrapCache: createWrapCache() });
      const hint = frame.lines.find((line) => line.some((part) =>
        part.text.includes("connection offline · reading")));

      expect(hint).toBeDefined();
      expect(hint!.map((part) => part.text).join(""))
        .toContain("connection offline · reading · overlays remain available · R retries");
      expect(hint!.map((part) => part.text).join("")).not.toContain("R retri…");
    }
  });

  test("theme command switches the palette for the frame", async () => {
    const source = demoAppSource();
    await renderOnce(source, 120, 36, ":parchment\r");
    expect(source.config.theme).toBe("parchment");
  });

  test("summary command opens the modal with stretch and lock copy", async () => {
    const frame = await renderOnce(demoAppSource(), 120, 36, "\u001b:sum\r");
    expect(frame).toContain("summary take ━ compressing ¶ 1–13 into a continuity record");
    expect(frame).toContain("summarized stretch is locked while this writes");
    expect(frame).toContain("esc discards");
    expect(frame).toContain("SUMMARY");
  });

  test("demo disconnect command raises the banner and R clears it", async () => {
    const frame = await renderOnce(demoAppSource(), 120, 36, ":disconnect\r");
    expect(frame).toContain("▲ connection lost");
    expect(frame).toContain("R retries now");
    const recovered = await renderOnce(demoAppSource(), 120, 36, ":disconnect\r\u001bR");
    expect(recovered).not.toContain("▲ connection lost");

    const compact = await renderOnce(demoAppSource(), 80, 24, ":disconnect\r");
    const banner = lineContaining(compact, "▲ connection lost");
    expect(banner).toContain("saved on disk · R retries now");
    expect(/sav…R/.test(banner)).toBeFalse();

    const palette = await renderOnce(demoAppSource(), 120, 36, "\u001b:disconnect\r:");
    const suggested = palette.indexOf("Suggested");
    expect(palette.indexOf("reconnect", suggested)).toBeLessThan(palette.indexOf("export markdown", suggested));
    const paletteRetry = await renderOnce(demoAppSource(), 120, 36, "\u001b:disconnect\r:\r");
    expect(paletteRetry).not.toContain("▲ connection lost");
  });

  test("chapters overlay combines TOC, summary state, and context total", async () => {
    const frame = await renderOnce(demoAppSource(), 120, 36, "\u001bc");
    expect(frame).toContain("┏━ chapters · 3 on this storyline");
    expect(frame).toContain("72 ✓ summary");
    expect(frame).toContain("208 raw — no summary");
    expect(frame).toContain("total 884 / 32.8k");
    expect(frame).toContain("s summarize · e rename · n break · d remove");
  });

  test("80x24 library and chapters compact without clipping useful fields", async () => {
    const library = await renderOnce(demoAppSource(), 80, 24, "o");
    const libraryHeader = lineContaining(library, "title");
    expect(libraryHeader).toContain("words");
    expect(libraryHeader).toContain("structure");
    expect(libraryHeader).not.toContain("updated");
    expect(library).toContain("23 parts · 11 lines");
    expectNarrowPanelRowsBounded(library);

    const source = demoAppSource();
    source.settings = { ...source.settings, contextWindow: 100 };
    source.settingsView = {
      ...source.settingsView,
      effective: source.settings,
      effectiveProse: source.settings
    };
    const priorChapterIds = new Set(["p6", "p7", "p8", "p9", "p10"]);
    for (const part of source.payload.path) {
      if (priorChapterIds.has(part.id)) part.text = "storm ".repeat(500);
    }
    const chapters = await renderOnce(source, 80, 24, "c");
    const rawChapter = lineContaining(chapters, "raw — no summary");
    expect(rawChapter).toMatch(/raw — no summary\s+\[!\]/);
    expect(chapters).toContain("current ·");
    expectNarrowPanelRowsBounded(chapters);
  });

  test("CJK user text keeps library, chapter, and fact columns cell-aligned at 80x24", async () => {
    const librarySource = demoAppSource();
    const stories = [
      { ...librarySource.stories[0]!, title: "灯台守の長い物語".repeat(8) },
      ...librarySource.stories.slice(1)
    ];
    librarySource.stories = stories;
    librarySource.api = { ...librarySource.api, listStories: async () => stories };
    const library = await renderOnce(librarySource, 80, 24, "o");
    const cjkStory = lineContaining(library, "灯台守");
    const asciiStory = lineContaining(library, "salt road almanac");
    expect(cellColumn(cjkStory, "23 parts")).toBe(cellColumn(asciiStory, "27 parts"));
    expectNarrowPanelRowsBounded(library);

    const chapterSource = demoAppSource();
    chapterSource.payload.chapterBreaks[0] = {
      ...chapterSource.payload.chapterBreaks[0]!,
      title: "灯台守の章".repeat(8)
    };
    const chapters = await renderOnce(chapterSource, 80, 24, "c");
    const cjkChapter = lineContaining(chapters, "灯台守");
    const asciiChapter = lineContaining(chapters, "The Compass");
    expect(cellColumn(cjkChapter, "parts 6–10")).toBe(cellColumn(asciiChapter, "parts 11–13"));
    expectNarrowPanelRowsBounded(chapters);

    const factSource = demoAppSource();
    factSource.payload.facts[0] = {
      ...factSource.payload.facts[0]!,
      tag: "分類".repeat(12),
      text: "灯台守".repeat(16) + "\n海辺の記録"
    };
    const facts = await renderOnce(factSource, 80, 24, "f");
    const cjkFact = lineContaining(facts, "▸ 灯台守");
    const asciiFact = lineContaining(facts, "Ashe");
    const cjkTag = cjkFact.indexOf("分類");
    const asciiTag = asciiFact.indexOf("people");
    expect(cellColumn(cjkFact, "分類")).toBe(cellColumn(asciiFact, "people"));
    expect(cellColumn(cjkFact, "海", cjkTag)).toBe(cellColumn(asciiFact, "Carries", asciiTag));
    expectNarrowPanelRowsBounded(facts);
  });

  test("tag manager pads CJK names and colors every label semantically", () => {
    const state = initialState(demoAppSource(), true);
    const tag = state.payload.tags[0]!;
    state.payload.tags = [
      { ...tag, name: "灯台守".repeat(7), status: "Canon" },
      { ...tag, name: "plain mark", status: "Alt" },
      { ...tag, name: "rough mark", status: "Draft" },
      { ...tag, name: "dead mark", status: "Discarded" },
      { ...tag, name: "loose mark", status: "" },
      { ...tag, name: "summary mark", status: "Summary" }
    ];
    state.mode = "COMMANDS";
    state.commands = {
      cursor: 0, selectedId: null, query: "", view: "tags", returnMode: "NAV"
    };
    const rendered = renderStoryScreen(state, { width: 80, height: 24, wrapCache: createWrapCache() });
    const text = frameText(rendered.lines);
    const cjk = lineContaining(text, "Canon");
    const ascii = lineContaining(text, "Alt");

    expect(cellColumn(cjk, "Canon")).toBe(cellColumn(ascii, "Alt"));
    for (const [label, role] of [
      ["Canon", "tag · canon"],
      ["Alt", "tag · alt"],
      ["Draft", "tag · draft"],
      ["Discarded", "tag · discarded"],
      ["none", "prose · dim"],
      ["Summary", "summary"]
    ] as const) {
      expect(rendered.lines.flat().find((part) => part.text === label)?.role).toBe(role);
    }
    expectNarrowPanelRowsBounded(text);
  });

  test("focused chapter summary expands inline and stale state is explicit", async () => {
    const demo = createDemoController();
    const payload = demo.editNode("p1", { text: "Maren changed the opening after the recap." });
    const source = demoAppSource();
    source.payload = payload;
    source.api = demoStoryApi(demo);
    const frame = await renderWithKeys(source, 120, 36, [
      key("escape", "\u001b"),
      key("g"),
      ...Array.from({ length: 5 }, () => key("down", "")),
      key("return", "\r")
    ]);
    expect(frame).toContain("stale — chapter changed");
    expect(frame).toContain("prose untouched · summary only changes model context");
    expect(frame).toContain("e edit · r refresh");
  });

  test("shift-C creates a break through the ordinary key pipeline", async () => {
    const frame = await renderOnce(demoAppSource(), 120, 36, "C");
    expect(frame).toContain("chapter break added · chapters renumbered · u undoes");
  });
});

/** A format-2 settings view whose one connection uses the given preset and
 *  protocol, built from the ground up as the dataFormat-2 branch — spreading
 *  a fixture already typed as the broad `SettingsView` union does not narrow
 *  under TypeScript. */
function routeSource(preset: SettingsPresetV2, protocol: SettingsProtocolV2) {
  const source = demoAppSource();
  const view: SettingsView = {
    dataFormat: 2,
    editable: true,
    stateGeneration: 1,
    activeRevision: 1,
    pendingRevision: null,
    document: {
      ...DEMO_SETTINGS_DOCUMENT,
      connections: {
        demo: { ...DEMO_SETTINGS_DOCUMENT.connections.demo!, preset, protocol }
      }
    },
    effective: source.settingsView.effective,
    effectiveProse: source.settingsView.effectiveProse,
    lastActivationOutcome: null
  };
  source.settingsView = view;
  return source;
}

function legacySource() {
  const source = demoAppSource();
  source.settingsView = {
    dataFormat: 1,
    editable: false,
    stateGeneration: null,
    activeRevision: null,
    pendingRevision: null,
    document: null,
    effective: source.settingsView.effective,
    effectiveProse: source.settingsView.effectiveProse,
    lastActivationOutcome: null
  };
  return source;
}

/** A take whose text and captured steps are both under this module's control,
 *  so the golden assertions below can check exact probabilities rather than
 *  guessing at the shipped demo story's prose. `dryRunProbabilityStep` is the
 *  same deterministic fabrication `server/providers.ts` uses for a live
 *  dry-run generation (issue #291 phase 2), reused here rather than
 *  reinvented so this fixture can never drift from what the real stream
 *  actually produces. */
function populatedTokenProbabilitiesSource(requested = 16) {
  const demo = createDemoController();
  const parentId = demo.payload().path.at(-1)!.id;
  const text = "the lantern guttered as Aldric stepped down into the pit and the dark below answered";
  const payload = demo.createChild(parentId, "continue", text);
  const leaf = payload.path.at(-1)!;
  const marked = {
    ...payload,
    nodes: payload.nodes.map((node) => node.id === leaf.id ? { ...node, tokenProbabilities: true as const } : node)
  };
  const words = text.match(/\s*\S+/g) ?? [];
  const steps = words.map((word, index) => dryRunProbabilityStep(word, requested, index));
  const record = createTokenProbabilities({ requested, steps, truncated: false }, 0);
  const source = demoAppSource();
  source.payload = marked;
  source.api = { ...source.api, getTokenProbabilities: async () => record };
  return { source, leaf, record };
}

describe("token probability viewer", () => {
  test("l opens the viewer and names why a route that has never asked has nothing to show", async () => {
    const frame = await renderOnce(demoAppSource(), 120, 36, "l");
    expect(frame).toContain("PROBS");
    expect(frame).toContain("token probabilities");
    expect(frame).toContain(
      "Press , for Settings. Set alt count (alternatives per token) to 1–20. Save, then generate again."
    );
    expect(frame).toContain("esc back");
  });

  test("empty state: legacy format 1 settings", async () => {
    const frame = await renderOnce(legacySource(), 120, 36, "l");
    expect(frame).toContain("Format 1 settings are read-only.");
  });

  test("empty state: Anthropic Messages names the presets that do document it", async () => {
    const frame = await renderOnce(routeSource("anthropic", "anthropic-messages"), 120, 36, "l");
    expect(frame).toContain("This provider does not support token probabilities.");
    expect(frame).toContain("OpenAI, OpenRouter, llama.cpp, KoboldCpp, LM Studio");
  });

  test("empty state: an endpoint outside the allow-list names the presets that do document it", async () => {
    const frame = await renderOnce(routeSource("ollama", "openai-chat-completions"), 120, 36, "l");
    expect(frame).toContain("Token probability support is unknown for this provider.");
    expect(frame).toContain("OpenAI, OpenRouter, llama.cpp, KoboldCpp, LM Studio");
  });

  test("populated: the table, the meter bars, and the sampled mark", async () => {
    const { source, leaf } = populatedTokenProbabilitiesSource();
    const state = initialState(source, true);
    const cache = createWrapCache<ProseStyle>();
    // Focus the crafted leaf directly — it is the only part on this line.
    state.focusIndex = rowIndexForNode(createStoryViewModel(state.payload), leaf.id);
    await handleKey({ name: "l", sequence: "l", shift: false, ctrl: false, meta: false } as KeyEvent,
      state, source, cache, () => {}, async () => {}, () => {});
    const frame = frameText(renderStoryScreen(state, { width: 120, height: 36, wrapCache: cache }).lines);
    expect(frame).toContain("token probabilities");
    expect(frame).toContain("logprobs · top 16");
    expect(frame).toContain("the lantern guttered");
    expect(frame).toContain("token");
    expect(frame).toContain("logprob");
    // The sampled token's own alternative always leads, at logprob -0.050.
    expect(frame).toMatch(/▸ the\s+0\.951\s+▮+▯*\s+-0\.050\s+✓ sampled/);
    expect(frame).toContain("4 more under 1 %");
    expect(frame).toContain("←→");
    expect(frame).toContain("⇥");
    // The column is right-aligned numbers under a label that exactly fills
    // its 7-cell width, so the two share a *trailing* edge — the header
    // text's own last cell, not its first. `columnHeaderLine`, not
    // `lineContaining`: the title line's "logprobs · top N" also contains
    // "logprob" as a substring.
    const header = columnHeaderLine(frame);
    const sampledRow = lineContaining(frame, "✓ sampled");
    expect(cellColumn(header, "logprob") + "logprob".length)
      .toBe(cellColumn(sampledRow, "-0.050") + "-0.050".length);
  });

  test("populated: the meter bar shrinks, then drops, as the surface narrows", async () => {
    const { source, leaf } = populatedTokenProbabilitiesSource();
    for (const [width, expectBar] of [[120, true], [90, true], [70, false]] as const) {
      const state = initialState(source, true);
      const cache = createWrapCache<ProseStyle>();
      state.focusIndex = rowIndexForNode(createStoryViewModel(state.payload), leaf.id);
      await handleKey({ name: "l", sequence: "l", shift: false, ctrl: false, meta: false } as KeyEvent,
        state, source, cache, () => {}, async () => {}, () => {});
      const frame = frameText(renderStoryScreen(state, { width, height: 36, wrapCache: cache }).lines);
      expect(frame.includes("▮")).toBe(expectBar);
      // Whatever the bar's width, the header and the sampled row's own
      // logprob still share their trailing edge (see the note above).
      const header = columnHeaderLine(frame);
      const sampledRow = lineContaining(frame, "✓ sampled");
      expect(cellColumn(header, "logprob") + "logprob".length)
        .toBe(cellColumn(sampledRow, "-0.050") + "-0.050".length);
      for (const line of frame.split("\n")) expect(cellWidth(line) <= width).toBeTrue();
    }
  });

  test("arrow navigation moves the selected token and re-renders its alternatives", async () => {
    const { source, leaf } = populatedTokenProbabilitiesSource();
    const state = initialState(source, true);
    const cache = createWrapCache<ProseStyle>();
    state.focusIndex = rowIndexForNode(createStoryViewModel(state.payload), leaf.id);
    const press = (name: string) => handleKey(
      { name, sequence: name, shift: false, ctrl: false, meta: false } as KeyEvent,
      state, source, cache, () => {}, async () => {}, () => {}
    );
    await press("l");
    expect(state.probs?.tokenIndex).toBe(0);
    await press("right");
    expect(state.probs?.tokenIndex).toBe(1);
    // Every token starts its own alternatives list freshly collapsed.
    expect(state.probs?.altIndex).toBe(0);
    expect(state.probs?.expanded).toBe(false);
    const frameAfterMove = frameText(renderStoryScreen(state, { width: 120, height: 36, wrapCache: cache }).lines);
    expect(frameAfterMove).toContain("token 2 of");

    // 12 visible alternatives (indices 0..11) then the collapsed row at 12.
    for (let index = 0; index < 12; index += 1) await press("down");
    expect(state.probs?.altIndex).toBe(12);
    await press("down");
    // The synthetic "n more" row expands and the cursor lands on the first
    // alternative it was hiding, without a second keypress.
    expect(state.probs?.expanded).toBe(true);
    expect(state.probs?.altIndex).toBe(12);
    const expandedFrame = frameText(renderStoryScreen(state, { width: 120, height: 36, wrapCache: cache }).lines);
    expect(expandedFrame).not.toContain("more under 1 %");

    await press("escape");
    expect(state.mode).toBe("NAV");
    expect(state.probs).toBe(null);
  });
});
