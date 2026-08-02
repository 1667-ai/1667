import assert from "node:assert/strict";
import test from "node:test";
import { terminalLineText, terminalProseText } from "../shared/terminal-text.js";
import { cellWidth as visibleWidth } from "../tui/src/cell-width.js";

interface TableRowCase {
  readonly name: string;
  readonly input: string;
  readonly expectedLine: string;
  readonly expectedProse: string;
}

const TABLE_ROWS: readonly TableRowCase[] = [
  {
    name: "U+0000–U+0008 C0 controls",
    input: "a\u0000\u0007\u0008b",
    expectedLine: "a▪▪▪b",
    expectedProse: "a▪▪▪b"
  },
  {
    name: "U+0009 TAB",
    input: "a\tb",
    expectedLine: "a\tb",
    expectedProse: "a\tb"
  },
  {
    name: "U+000A LF",
    input: "a\nb",
    expectedLine: "a▪b",
    expectedProse: "a\nb"
  },
  {
    name: "U+000B–U+000C VT FF",
    input: "a\v\fb",
    expectedLine: "a▪▪b",
    expectedProse: "a▪▪b"
  },
  {
    name: "U+000D CR",
    input: "a\rb",
    expectedLine: "a b",
    expectedProse: "a b"
  },
  {
    name: "U+000E–U+001F C0 controls (including ESC)",
    input: "a\x1b[31mb",
    expectedLine: "a▪[31mb",
    expectedProse: "a▪[31mb"
  },
  {
    name: "U+007F DEL",
    input: "a\x7fb",
    expectedLine: "a▪b",
    expectedProse: "a▪b"
  },
  {
    name: "U+0080–U+009F C1 controls",
    input: "a\u0080\u009f\u009bb",
    expectedLine: "a▪▪▪b",
    expectedProse: "a▪▪▪b"
  },
  {
    name: "U+2028, U+2029 Line and Paragraph separators",
    input: "a\u2028\u2029b",
    expectedLine: "a▪▪b",
    expectedProse: "a▪▪b"
  },
  {
    name: "U+202A–U+202E, U+2066–U+2069 Bidi controls",
    input: "a\u202E\u2066b",
    expectedLine: "a▪▪b",
    expectedProse: "a\u202E\u2066b"
  },
  {
    name: "U+200E, U+200F, U+200B–U+200D, U+FEFF Bidi marks, ZWSP/joiners, BOM",
    input: "a\u200E\u200F\u200B\u200C\u200D\uFEFFb",
    expectedLine: "a\u200E\u200F\u200B\u200C\u200D\uFEFFb",
    expectedProse: "a\u200E\u200F\u200B\u200C\u200D\uFEFFb"
  }
];

test("terminal projection preserves string length, visible width, and maps each regime for every row in the character table", () => {
  for (const row of TABLE_ROWS) {
    const projectedLine = terminalLineText(row.input);
    assert.equal(
      projectedLine,
      row.expectedLine,
      `Line regime failure for ${row.name}`
    );
    assert.equal(
      projectedLine.length,
      row.input.length,
      `Length preservation failure (Line) for ${row.name}`
    );
    assert.equal(
      visibleWidth(projectedLine),
      visibleWidth(row.input),
      `Width preservation failure (Line) for ${row.name}`
    );

    const projectedProse = terminalProseText(row.input);
    assert.equal(
      projectedProse,
      row.expectedProse,
      `Prose regime failure for ${row.name}`
    );
    assert.equal(
      projectedProse.length,
      row.input.length,
      `Length preservation failure (Prose) for ${row.name}`
    );
    assert.equal(
      visibleWidth(projectedProse),
      visibleWidth(row.input),
      `Width preservation failure (Prose) for ${row.name}`
    );
  }
});
