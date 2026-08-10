import { describe, expect, test } from "bun:test";
import { noticeMarkupBlocks, parseNoticeMarkup } from "../src/notice-markup.js";

// `parseNoticeMarkup` is deliberately pure (markdown text in, `{text, runs}`
// out) so the marker edge cases below — the ones a rendered-frame assertion
// cannot show cleanly, because a dropped or duplicated character reads the
// same in a wrapped row either way — are checked directly here. The
// paragraph/list/bold/code behavior itself is covered end to end against a
// rendered log frame in notice-log.test.ts; this file does not repeat that.
describe("parseNoticeMarkup", () => {
  test("strips ** markers and marks the span bold", () => {
    const { text, runs } = parseNoticeMarkup("plain **bold** text");
    expect(text).toBe("plain bold text");
    expect(runs).toEqual([{ start: 6, end: 10, style: "bold" }]);
  });

  test("strips backtick markers and marks the span code", () => {
    const { text, runs } = parseNoticeMarkup("use `always` mode");
    expect(text).toBe("use always mode");
    expect(runs).toEqual([{ start: 4, end: 10, style: "code" }]);
  });

  // The rule this whole module exists to keep: a marker with no partner is
  // never dropped, only ever left exactly as written.
  test("a lone, unmatched * survives as literal text", () => {
    const { text, runs } = parseNoticeMarkup("5 * 3 = 15");
    expect(text).toBe("5 * 3 = 15");
    expect(runs).toEqual([]);
  });

  test("an unclosed ** survives as literal text", () => {
    const { text, runs } = parseNoticeMarkup("this **never closes");
    expect(text).toBe("this **never closes");
    expect(runs).toEqual([]);
  });

  test("an unclosed backtick survives as literal text", () => {
    const { text, runs } = parseNoticeMarkup("a stray ` mark");
    expect(text).toBe("a stray ` mark");
    expect(runs).toEqual([]);
  });

  test("a blank line becomes a paragraph break", () => {
    const { text } = parseNoticeMarkup("first paragraph\n\nsecond paragraph");
    expect(text).toBe("first paragraph\n\nsecond paragraph");
  });

  // The source-wrapped continuation lines CHANGELOG.md entries carry (a
  // 2-space indent, no blank line before the next line) are a formatting
  // artifact of the markdown source, not a paragraph break.
  test("continuation lines with no blank line between them join one paragraph", () => {
    const { text } = parseNoticeMarkup("first line\n  continues here");
    expect(text).toBe("first line continues here");
  });

  test("a - list item always starts a new block, blank line before it or not", () => {
    const { text } = parseNoticeMarkup("- first item\n- second item");
    expect(text).toBe("- first item\n- second item");
  });

  test("collapses repeated internal whitespace the way the old flatten did", () => {
    const { text } = parseNoticeMarkup("too   many    spaces");
    expect(text).toBe("too many spaces");
  });
});

describe("noticeMarkupBlocks", () => {
  test("finds list items and a plain paragraph in the cleaned text", () => {
    const { text } = parseNoticeMarkup("heading\n- first item\n- second item");
    const blocks = noticeMarkupBlocks(text);
    expect(blocks.map((block) => block.list)).toEqual([false, true, true]);
    expect(blocks.map((block) => text.slice(block.start, block.end))).toEqual([
      "heading",
      "- first item",
      "- second item"
    ]);
  });

  test("a blank-line paragraph break is its own empty block", () => {
    const { text } = parseNoticeMarkup("first\n\nsecond");
    const blocks = noticeMarkupBlocks(text);
    expect(blocks).toHaveLength(3);
    expect(blocks[1]).toMatchObject({ list: false });
    expect(text.slice(blocks[1]!.start, blocks[1]!.end)).toBe("");
  });
});
