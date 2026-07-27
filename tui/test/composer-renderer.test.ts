import { describe, expect, test } from "bun:test";
import {
  platformPerformanceBudget
} from "../../test/platform-performance-budget.js";
import {
  backspaceComposer,
  composerLineCell,
  composerLineCount,
  composerLineIdentity,
  composerLineLength,
  composerLineSnapshot,
  composerPosition,
  composerSelection,
  createComposer,
  insertComposerText,
  moveComposerHorizontal,
  moveComposerTo,
  moveComposerVertical,
  redoComposerEdit,
  replaceComposerTextRange,
  selectedComposerText,
  undoComposerEdit
} from "../src/composer-model.js";
import {
  deleteComposerLine,
  moveComposerBufferBoundary,
  moveComposerWord
} from "../src/composer-editing.js";
import { moveComposerVisualVertical, wrappedComposerLayout } from "../src/composer-wrapping.js";
import {
  applyComposeMode,
  composerHeightCap,
  renderComposerLayout
} from "../src/screens/story/composer.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText, segment, type FrameLine } from "../src/screens/story/frame.js";
import { initialState } from "../src/app.js";
import { demoAppSource } from "../src/demo.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";

describe("composer renderer", () => {
  test("uses the terminal-third cap unless config overrides it", () => {
    expect(composerHeightCap(36)).toBe(12);
    expect(composerHeightCap(24)).toBe(8);
    expect(composerHeightCap(10)).toBe(6);
    expect(composerHeightCap(36, 4)).toBe(4);
  });

  test("frames the composer on entry and places the solid caret at its grapheme offset", () => {
    const composer = createComposer("A💡B");
    composer.cursor = 2;
    const layout = renderComposerLayout({
      composer, terminalWidth: 80, terminalHeight: 24, measure: 52, indent: "  ", directingPart: 13
    });

    expect(layout.lines).toHaveLength(3);
    expect(frameText(layout.lines)).toContain("┏━ compose · ¶ 13");
    const caret = layout.lines[1]!.find((part) => part.background === "compose accent");
    expect(caret).toMatchObject({ text: "B", role: "background" });
    expect(frameText(layout.lines)).toContain("enter send · ⇧enter newline");
  });

  test("grows per newline, reports headroom, then scrolls around the cursor", () => {
    const composer = createComposer(Array.from({ length: 10 }, (_, index) => `line ${index}`).join("\n"));
    const layout = renderComposerLayout({
      composer, terminalWidth: 80, terminalHeight: 24, measure: 60
    });

    expect(layout).toMatchObject({ lineCount: 10, cap: 8, bodyRows: 8, scrollTop: 2, cursorViewportRow: 7 });
    expect(layout.lines).toHaveLength(10);
    expect(frameText(layout.lines)).toContain("10 / 8 lines");
    expect(frameText(layout.lines)).not.toContain("line 0");
    expect(frameText(layout.lines)).toContain("line 9");

    moveComposerVertical(composer, -1);
    const moved = renderComposerLayout({
      composer, terminalWidth: 80, terminalHeight: 24, measure: 60, scrollTop: layout.scrollTop
    });
    expect(moved).toMatchObject({ scrollTop: 2, cursorViewportRow: 6 });
  });

  test("marks clipped non-cursor rows with a cell-safe ellipsis", () => {
    const composer = createComposer(`${"x".repeat(30)}\ntail`);
    const layout = renderComposerLayout({
      composer, terminalWidth: 16, terminalHeight: 24, measure: 16
    });

    expect(frameText(layout.lines)).toContain("┃ › xxxxxxxxxxx…");
  });

  test("carries the composer viewport between story frames", () => {
    const state = initialState(demoAppSource(), false);
    state.mode = "COMPOSE";
    state.composer = createComposer(Array.from({ length: 10 }, (_, index) => `line ${index}`).join("\n"));
    const first = renderStoryScreen(state, { width: 80, height: 24 });
    state.composerScrollTop = first.derived.composerScrollTop;

    moveComposerVertical(state.composer, -1);
    const moved = renderStoryScreen(state, { width: 80, height: 24 });

    expect(first.derived.composerScrollTop).toBe(2);
    expect(moved.derived.composerScrollTop).toBe(2);
  });

  test("fullscreen owns every row except the persistent status row", () => {
    const composer = createComposer("one\ntwo");
    composer.fullscreen = true;
    const layout = renderComposerLayout({
      composer, terminalWidth: 72, terminalHeight: 12, measure: 50
    });

    expect(layout).toMatchObject({ fullscreen: true, bodyRows: 9, fieldWidth: 72 });
    expect(layout.lines).toHaveLength(11);
    expect(frameText(layout.lines)).toContain("compose · fullscreen");
    expect(frameText(layout.lines)).toContain("⌃f exit · esc inline");
  });

  test("soft-wraps long document lines across full-screen visual rows", () => {
    const composer = createComposer("abcdefghijklmnopqr");
    composer.fullscreen = true;
    const layout = renderComposerLayout({
      composer, terminalWidth: 12, terminalHeight: 12, measure: 12, softWrap: true
    });
    const text = frameText(layout.lines);

    expect(layout).toMatchObject({ lineCount: 1, bodyRows: 9, scrollTop: 0, cursorViewportRow: 2 });
    expect(text).toContain("┃ › abcdefgh");
    expect(text).toContain("┃   ijklmnop");
    expect(text).toContain("┃   qr");
    expect(layout.lines.slice(1, 4).flat().some(({ text }) => text === "…")).toBeFalse();
  });

  test("keeps exact-width line endpoints as stable continuation rows", () => {
    const composer = createComposer("1234\nnext");
    moveComposerTo(composer, 4);
    const wrapped = wrappedComposerLayout(composer, 4);

    expect(wrapped.rowCount).toBe(4);
    expect(wrapped.cursorRow).toBe(1);
    expect(wrapped.rowAt(0)).toMatchObject({ sourceIndex: 0, start: 0, end: 4 });
    expect(wrapped.rowAt(1)).toMatchObject({ sourceIndex: 0, start: 4, end: 4 });
    expect(wrapped.rowAt(2)).toMatchObject({ sourceIndex: 1, start: 0, end: 4 });
    expect(wrapped.rowAt(3)).toMatchObject({ sourceIndex: 1, start: 4, end: 4 });

    expect(moveComposerVisualVertical(composer, -1, 4)).toBeTrue();
    expect(composerPosition(composer)).toEqual({ line: 0, column: 0 });
    expect(moveComposerVisualVertical(composer, 1, 4)).toBeTrue();
    expect(composerPosition(composer)).toEqual({ line: 0, column: 4 });
  });

  test("indexes mixed-width wrap boundaries by terminal cells", () => {
    const composer = createComposer("a界bc界d");
    const wrapped = wrappedComposerLayout(composer, 4);
    expect(wrapped.rowCount).toBe(3);
    expect(wrapped.rowAt(0)).toMatchObject({ start: 0, end: 3 });
    expect(wrapped.rowAt(1)).toMatchObject({ start: 3, end: 6 });
    expect(wrapped.rowAt(2)).toMatchObject({ start: 6, end: 6 });

    moveComposerTo(composer, 3);
    expect(wrappedComposerLayout(composer, 4).cursorRow).toBe(1);
    moveComposerTo(composer, 6);
    expect(moveComposerVisualVertical(composer, -1, 4)).toBeTrue();
    expect(composerPosition(composer)).toEqual({ line: 0, column: 3 });
    expect(wrappedComposerLayout(composer, 4).cursorRow).toBe(1);
  });

  test("selects graphemes, replaces selections, and supports compact undo/redo", () => {
    const composer = createComposer("alpha beta\ngamma");
    moveComposerBufferBoundary(composer, false);
    moveComposerWord(composer, 1);
    for (let index = 0; index < 4; index += 1) moveComposerHorizontal(composer, 1, true);
    expect(composerSelection(composer)).toEqual({ start: 6, end: 10 });
    expect(selectedComposerText(composer)).toBe("beta");

    insertComposerText(composer, "B");
    expect(composer.text).toBe("alpha B\ngamma");
    expect(undoComposerEdit(composer)).toBeTrue();
    expect(composer.text).toBe("alpha beta\ngamma");
    expect(selectedComposerText(composer)).toBe("beta");
    expect(redoComposerEdit(composer)).toBeTrue();
    expect(composer.text).toBe("alpha B\ngamma");

    deleteComposerLine(composer);
    expect(composer.text).toBe("gamma");
  });

  test("paints selections across soft-wrapped visual rows", () => {
    const composer = createComposer("abcdefghijklmnopqr");
    composer.fullscreen = true;
    moveComposerBufferBoundary(composer, false);
    moveComposerBufferBoundary(composer, true, true);
    const layout = renderComposerLayout({
      composer, terminalWidth: 12, terminalHeight: 12, measure: 12, softWrap: true
    });
    const selected = layout.lines.flat()
      .filter((part) => part.background === "compose accent")
      .map((part) => part.text).join("");
    expect(selected).toBe("abcdefghijklmnopqr");
  });

  test("paints a selected line break before destructive replacement", () => {
    const composer = createComposer("one\ntwo");
    moveComposerBufferBoundary(composer, false);
    for (let index = 0; index < 3; index += 1) moveComposerHorizontal(composer, 1);
    moveComposerHorizontal(composer, 1, true);
    expect(selectedComposerText(composer)).toBe("\n");

    const layout = renderComposerLayout({
      composer, terminalWidth: 20, terminalHeight: 12, measure: 20, softWrap: true
    });
    expect(layout.lines.flat().some((part) =>
      part.text === " " && part.background === "compose accent")).toBeTrue();
    insertComposerText(composer, "X");
    expect(composer.text).toBe("oneXtwo");
  });

  test("paints a selected line break in an unwrapped non-cursor row", () => {
    const composer = createComposer("one\ntwo");
    moveComposerTo(composer, 3);
    moveComposerHorizontal(composer, 1, true);

    const layout = renderComposerLayout({
      composer, terminalWidth: 20, terminalHeight: 12, measure: 20
    });
    expect(layout.lines.flat().some((part) =>
      part.text === " "
      && part.background === "focus / accent"
      && part.composerStart === 3)).toBeTrue();
  });

  test("paints only a marker for a selected line break after an exact-width row", () => {
    const composer = createComposer("1234\nnext");
    moveComposerTo(composer, 4);
    moveComposerHorizontal(composer, 1, true);

    const layout = renderComposerLayout({
      composer, terminalWidth: 8, terminalHeight: 12, measure: 8, softWrap: true,
      caret: "unfocused"
    });
    const selected = layout.lines.flat()
      .filter((part) => part.background === "compose accent")
      .map((part) => part.text);
    expect(selected).toEqual([" "]);
    expect(selectedComposerText(composer)).toBe("\n");
  });

  test("moves and extends selection by soft-wrapped visual rows", () => {
    const composer = createComposer("abcdefghij");
    expect(moveComposerVisualVertical(composer, -1, 4, true)).toBeTrue();
    expect(composer).toMatchObject({ cursor: 6, anchor: 10 });
    expect(selectedComposerText(composer)).toBe("ghij");
  });

  test("unmodified visual movement clears a selection at the viewport boundary", () => {
    const composer = createComposer("keep me");
    moveComposerBufferBoundary(composer, false);
    moveComposerBufferBoundary(composer, true, true);
    expect(composerSelection(composer)).not.toBe(null);

    expect(moveComposerVisualVertical(composer, 1, 20)).toBeFalse();
    expect(composerSelection(composer)).toBe(null);
    insertComposerText(composer, "!");
    expect(composer.text).toBe("keep me!");
  });

  test("down on the last editor line moves to its end before newline input", () => {
    const composer = createComposer("one\nlast line");
    moveComposerTo(composer, 6);

    expect(moveComposerVisualVertical(composer, 1, 20)).toBeTrue();
    expect(composerPosition(composer)).toEqual({ line: 1, column: 9 });
    insertComposerText(composer, "\n");
    expect(composer.text).toBe("one\nlast line\n");
  });

  test("whole-line deletion replaces an active selection", () => {
    const composer = createComposer("one\ntwo\nthree");
    moveComposerTo(composer, 4);
    moveComposerTo(composer, 7, true);
    deleteComposerLine(composer);
    expect(composer.text).toBe("one\n\nthree");
    expect(composerSelection(composer)).toBe(null);
  });

  test("retains the preferred column across short visual rows", () => {
    const composer = createComposer("abcdef\nx\nabcdef");
    expect(moveComposerVisualVertical(composer, -1, 20)).toBeTrue();
    expect(composerPosition(composer)).toEqual({ line: 1, column: 1 });
    expect(moveComposerVisualVertical(composer, -1, 20)).toBeTrue();
    expect(composerPosition(composer)).toEqual({ line: 0, column: 6 });

    moveComposerHorizontal(composer, -1);
    expect(moveComposerVisualVertical(composer, 1, 20)).toBeTrue();
    expect(moveComposerVisualVertical(composer, 1, 20)).toBeTrue();
    expect(composerPosition(composer)).toEqual({ line: 2, column: 5 });
  });

  test("active generation uses the machine caret and fullscreen skips hidden prose wrapping", () => {
    const state = initialState(demoAppSource(), true);
    state.mode = "COMPOSE";
    state.composer = createComposer("hold this direction");
    const inline = renderStoryScreen(state, {
      width: 80, height: 24, wrapCache: createWrapCache<ProseStyle>()
    });
    expect(inline.lines.flat().find((part) => part.text === "▏")).toMatchObject({ role: "chrome" });

    state.composer.fullscreen = true;
    state.toast = "stream running · esc stops it first · draft kept";
    const fullscreenCache = createWrapCache<ProseStyle>();
    const fullscreen = renderStoryScreen(state, {
      width: 80, height: 24, wrapCache: fullscreenCache
    });
    expect(fullscreen.lines.flat().find((part) => part.text === "▏")).toMatchObject({ role: "chrome" });
    expect(fullscreen.lines.flat().find((part) => part.text === state.toast))
      .toMatchObject({ role: "compose accent" });
    expect(frameText(fullscreen.lines)).not.toContain("enter send");
    expect(fullscreenCache.misses).toBe(0);
  });

  test("inline refusal replaces footer hints above the optional page dim", () => {
    const state = initialState(demoAppSource(), true);
    state.mode = "COMPOSE";
    state.config = { ...state.config, composeFocus: "on" };
    state.toast = "offline · draft kept until the connection returns";

    const frame = renderStoryScreen(state, { width: 80, height: 24 });
    const notices = frame.lines.flat().filter((part) => part.text === state.toast);

    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ role: "compose accent", background: "raised" });
    expect(frameText(frame.lines)).not.toContain("enter send");
  });

  test("recolors only accent chrome unless opt-in focus dim is enabled", () => {
    const story: FrameLine[] = [[
      segment("take", "focus / accent"),
      segment(" »", "accent · deep"),
      segment(" prose", "prose"),
      segment(" edit", "human edit")
    ]];
    expect(applyComposeMode(story)[0]!.map((part) => part.role)).toEqual([
      "compose accent", "compose accent", "prose", "human edit"
    ]);
    expect(applyComposeMode(story, true)[0]!.map((part) => part.role)).toEqual([
      "dimmed page", "dimmed page", "dimmed page", "dimmed page"
    ]);
  });

  test("inserts and renders a very large paste without argument-limit or quadratic cursor work", () => {
    const composer = createComposer("ab");
    composer.cursor = 1;
    insertComposerText(composer, "x".repeat(200_000));
    expect(composer.text.slice(0, 4)).toBe("axxx");
    expect(composer.text.slice(-4)).toBe("xxxb");
    expect(composer.cursor).toBe(200_001);

    const started = performance.now();
    const layout = renderComposerLayout({
      composer, terminalWidth: 100, terminalHeight: 30, measure: 72
    });
    expect(frameText(layout.lines)).toContain("…");
    expect(performance.now() - started).toBeLessThan(
      platformPerformanceBudget(1_000)
    );

    // The large-paste guarantee covers editing after the paste, not merely the
    // first paint. This caught whole-draft resegmentation on every keystroke.
    renderComposerLayout({
      composer, terminalWidth: 100, terminalHeight: 30, measure: 72, softWrap: true
    });
    const editingStarted = performance.now();
    for (let index = 0; index < 25; index += 1) {
      insertComposerText(composer, "y");
      renderComposerLayout({
        composer, terminalWidth: 100, terminalHeight: 30, measure: 72, softWrap: true
      });
      backspaceComposer(composer);
    }
    expect(performance.now() - editingStarted).toBeLessThan(
      platformPerformanceBudget(250)
    );
  });

  test("undo and redo preserve untouched line indexes", () => {
    const composer = createComposer(Array.from(
      { length: 1_000 }, (_, index) => `stable-${index}`
    ).join("\n"));
    const firstLine = composerLineIdentity(composer, 0);

    insertComposerText(composer, "!");
    expect(undoComposerEdit(composer)).toBeTrue();
    expect(composerLineIdentity(composer, 0)).toBe(firstLine);
    expect(composerLineSnapshot(composer).change?.full).toBeFalse();
    expect(redoComposerEdit(composer)).toBeTrue();
    expect(composerLineIdentity(composer, 0)).toBe(firstLine);
    expect(composerLineSnapshot(composer).change?.full).toBeFalse();
  });

  test("undo removes inserted text that joined adjacent graphemes", () => {
    const composer = createComposer("👩💻");
    moveComposerTo(composer, 1);
    insertComposerText(composer, "\u200d");
    expect(composer.text).toBe("👩‍💻");

    expect(undoComposerEdit(composer)).toBeTrue();
    expect(composer.text).toBe("👩💻");
    expect(redoComposerEdit(composer)).toBeTrue();
    expect(composer.text).toBe("👩‍💻");
  });

  test("soft-wraps a multi-megabyte uniform line without materializing every row", () => {
    const composer = createComposer("x".repeat(2_000_000));
    composer.fullscreen = true;
    const started = performance.now();
    const layout = renderComposerLayout({
      composer, terminalWidth: 100, terminalHeight: 30, measure: 100, softWrap: true
    });

    expect(layout.lines).toHaveLength(29);
    expect(layout.scrollTop).toBeGreaterThan(20_000);
    expect(performance.now() - started).toBeLessThan(
      platformPerformanceBudget(500)
    );
  });

  test("keeps edits incremental on a multi-megabyte mixed-width line", () => {
    const composer = createComposer(`界${"x".repeat(2_000_000)}`);
    composer.fullscreen = true;
    renderComposerLayout({
      composer, terminalWidth: 100, terminalHeight: 30, measure: 100, softWrap: true
    });

    const started = performance.now();
    insertComposerText(composer, "y");
    const layout = renderComposerLayout({
      composer, terminalWidth: 100, terminalHeight: 30, measure: 100, softWrap: true
    });
    expect(layout.scrollTop).toBeGreaterThan(20_000);
    expect(performance.now() - started).toBeLessThan(
      platformPerformanceBudget(250)
    );
  });

  test("inserts a newline-heavy paste without exceeding the argument limit", () => {
    const composer = createComposer("tail");
    composer.cursor = 0;

    insertComposerText(composer, "\n".repeat(100_000));

    expect(composerLineCount(composer)).toBe(100_001);
    expect(composer.cursor).toBe(100_000);
    expect(composer.text.endsWith("tail")).toBeTrue();
  });

  test("keeps soft-wrap edits incremental after a newline-heavy paste", () => {
    const composer = createComposer(`${"line\n".repeat(100_000)}tail`);
    composer.fullscreen = true;
    renderComposerLayout({
      composer, terminalWidth: 100, terminalHeight: 30, measure: 100, softWrap: true
    });
    const started = performance.now();
    insertComposerText(composer, "x");
    renderComposerLayout({
      composer, terminalWidth: 100, terminalHeight: 30, measure: 100, softWrap: true
    });

    expect(performance.now() - started).toBeLessThan(
      platformPerformanceBudget(100)
    );
  });

  test("incremental wrap blocks match a fresh index across multiline replacements", () => {
    const composer = createComposer(Array.from(
      { length: 700 }, (_, index) => index % 3 === 0 ? "界x" : `line-${index}`
    ).join("\n"));
    const assertFresh = () => {
      const incremental = wrappedComposerLayout(composer, 7);
      const fresh = createComposer(composer.text);
      moveComposerTo(fresh, composer.cursor);
      const rebuilt = wrappedComposerLayout(fresh, 7);
      expect(incremental.rowCount).toBe(rebuilt.rowCount);
      expect(incremental.cursorRow).toBe(rebuilt.cursorRow);
      for (let row = 0; row < incremental.rowCount; row += 1) {
        expect(incremental.rowAt(row)).toEqual(rebuilt.rowAt(row));
      }
    };

    wrappedComposerLayout(composer, 7);
    moveComposerTo(composer, 900);
    replaceComposerTextRange(composer, 890, 930, "wide界\nnew\nrows");
    assertFresh();
    replaceComposerTextRange(composer, 100, 1_100, "joined\nagain");
    assertFresh();
  });

  test("bounds seam repair when a Regional-Indicator insertion shifts a long run", () => {
    const flags = "🇦🇧".repeat(50_000);
    const composer = createComposer(`${flags}\n`);
    expect(moveComposerVertical(composer, -1)).toBeTrue();
    expect(composerPosition(composer)).toEqual({ line: 0, column: 0 });

    const started = performance.now();
    insertComposerText(composer, "🇨");
    const elapsed = performance.now() - started;

    expect(composer.text.length).toBe(flags.length + "🇨\n".length);
    expect(composer.text.slice(0, 6)).toBe("🇨🇦🇧");
    expect(composer.text.endsWith("🇦🇧\n")).toBeTrue();
    expect(composerLineLength(composer, 0)).toBe(50_001);
    expect(composerLineCell(composer, 0, 0)?.text).toBe("🇨🇦");
    expect(composerLineCell(composer, 0, 50_000)?.text).toBe("🇧");
    expect(composerLineCount(composer)).toBe(2);
    expect(composer).toMatchObject({ cursor: 1 });
    expect(elapsed).toBeLessThan(platformPerformanceBudget(1_000));
  });

  test("vertical movement preserves terminal-cell x across mixed-width lines", () => {
    const composer = createComposer("界界\nabcd\n🙂x");
    composer.cursor = 2; // cell x=4, after two wide glyphs

    expect(moveComposerVertical(composer, 1)).toBeTrue();
    expect(composerPosition(composer)).toEqual({ line: 1, column: 4 });
    expect(composer.cursor).toBe(7);

    // The short third line clamps, but moving back restores the preferred x.
    expect(moveComposerVertical(composer, 1)).toBeTrue();
    expect(composerPosition(composer)).toEqual({ line: 2, column: 2 });
    expect(moveComposerVertical(composer, -1)).toBeTrue();
    expect(composerPosition(composer)).toEqual({ line: 1, column: 4 });
  });

  test("moves and deletes whole combining and ZWJ graphemes", () => {
    const composer = createComposer("e\u0301👩‍👩‍👧‍👦x");
    expect(composer.cursor).toBe(3);
    moveComposerHorizontal(composer, -1);
    expect(composer.cursor).toBe(2);
    backspaceComposer(composer);
    expect(composer.text).toBe("e\u0301x");
    expect(composer.cursor).toBe(1);
    backspaceComposer(composer);
    expect(composer.text).toBe("x");

    const multiline = createComposer("e\u0301👩‍👩‍👧‍👦x\n界y");
    moveComposerHorizontal(multiline, -1);
    moveComposerVertical(multiline, -1);
    expect(multiline.cursor).toBe(1);

    const layout = renderComposerLayout({
      composer: createComposer("e\u0301👩‍👩‍👧‍👦x"), terminalWidth: 40, terminalHeight: 12, measure: 30
    });
    expect(frameText(layout.lines)).toContain("e\u0301👩‍👩‍👧‍👦x");
  });

  test("keeps the cursor valid when insertion joins adjacent graphemes", () => {
    const combining = createComposer("e");
    insertComposerText(combining, "\u0301");
    expect(combining).toMatchObject({ text: "e\u0301", cursor: 1 });
    moveComposerHorizontal(combining, -1);
    expect(combining.cursor).toBe(0);

    const joined = createComposer("👩👧");
    joined.cursor = 1;
    insertComposerText(joined, "\u200d");
    expect(joined).toMatchObject({ text: "👩‍👧", cursor: 1 });
    moveComposerHorizontal(joined, -1);
    expect(joined.cursor).toBe(0);
  });

  test("drops a whole grapheme when reserving the right ellipsis", () => {
    const composer = createComposer("ab1️⃣c");
    composer.cursor = 0;
    const layout = renderComposerLayout({
      composer, terminalWidth: 8, terminalHeight: 12, measure: 8
    });

    expect(frameText(layout.lines)).toContain("┃ › ab…");
    expect(frameText(layout.lines)).not.toContain("ab1…");
  });
});
