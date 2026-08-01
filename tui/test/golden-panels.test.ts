import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { handleKey, initialState, renderOnce } from "../src/app.js";
import { createDemoController, demoAppSource, demoStoryApi } from "../src/demo.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText } from "../src/screens/story/frame.js";
import { cellWidth } from "../src/cell-width.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";

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
    expect(library.text).toContain("8–21/25");
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
    expect(facts.text).toContain("9–21/25");
    expect(facts.text).toContain("▸ Fact 21");
    expect(hasSelectedHit(facts.hits)).toBeTrue();

    const tagsState = initialState(demoAppSource(), true);
    const tag = tagsState.payload.tags[0]!;
    tagsState.payload.tags = Array.from({ length: 25 }, (_, index) => ({
      ...tag, name: `mark ${String(index + 1).padStart(2, "0")}`
    }));
    tagsState.mode = "COMMANDS";
    tagsState.commands = { cursor: selected, selectedId: null, query: "", view: "tags" };
    const tags = render(tagsState);
    expect(tags.text).toContain("8–21/25");
    expect(tags.text).toContain("▸ mark 21");
    expect(hasSelectedHit(tags.hits)).toBeTrue();
  });

  test("command palette groups actions and fuzzy-filters with a live Search field", async () => {
    const grouped = await renderOnce(demoAppSource(), 120, 36, ":");
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
      query: `${"0123456789".repeat(20)}TAIL`, cursor: 0, selectedId: null, view: "commands"
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
      const lines = (await renderOnce(source, 120, 36, ",")).split("\n");
      const rowOf = (text: string): number => lines.findIndex((line) => line.includes(text));
      return { theme: rowOf("theme"), provider: rowOf("provider"), prompt: rowOf("system prompt") };
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
    state.commands = { cursor: 0, selectedId: null, query: "", view: "tags" };
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
