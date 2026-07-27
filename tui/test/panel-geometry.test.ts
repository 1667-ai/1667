import { describe, expect, test } from "bun:test";
import { hitAt, type HitRows } from "../src/hit.js";
import {
  panelHorizontalGeometry,
  placePanel,
  raisedSegment
} from "../src/screens/overlay.js";
import { plainLine, visibleWidth, type FrameLine } from "../src/screens/story/frame.js";

describe("shared panel horizontal geometry", () => {
  test("pins panel, content, footer, and title measures", () => {
    expect(panelHorizontalGeometry(120, 76)).toEqual({
      left: 22,
      right: 98,
      panelWidth: 76,
      contentInset: 2,
      contentLeft: 24,
      contentWidth: 72,
      footerInset: 2,
      footerLeft: 24,
      footerWidth: 72,
      titleOverhead: 6,
      titleWidth: 70
    });
    expect(panelHorizontalGeometry(80, 76)).toMatchObject({
      left: 4,
      right: 76,
      panelWidth: 72,
      contentWidth: 68,
      footerWidth: 68,
      titleWidth: 66
    });
    expect(panelHorizontalGeometry(24, 76)).toMatchObject({
      left: 2,
      right: 22,
      panelWidth: 20,
      contentWidth: 16,
      footerWidth: 16,
      titleWidth: 14
    });
  });

  test("placePanel paints and hits against those exact measures", () => {
    const width = 120;
    const height = 20;
    const horizontal = panelHorizontalGeometry(width, 76);
    const base: FrameLine[] = Array.from({ length: height }, () => []);
    const hits: HitRows = Array.from({ length: height }, () => null);
    const title = "t".repeat(horizontal.titleWidth);
    const body = "b".repeat(horizontal.contentWidth);
    const footer = "f".repeat(horizontal.footerWidth);
    const rendered = placePanel(
      base,
      title,
      [[raisedSegment(body)]],
      footer,
      width,
      height,
      76,
      {
        rows: hits,
        targets: [null],
        overrides: [[{
          target: { kind: "list", index: 7 },
          left: 0,
          right: 1
        }]],
        footerActions: [{ token: "f", action: "cancel" }]
      }
    );

    expect(rendered.selectable).toMatchObject({
      left: horizontal.left,
      right: horizontal.right
    });
    const top = rendered.selectable!.top;
    const titleLine = plainLine(rendered.lines[top]!)
      .slice(horizontal.left, horizontal.right);
    const bodyLine = plainLine(rendered.lines[top + 2]!)
      .slice(horizontal.left, horizontal.right);
    // The frame closes on all four sides, with a cell of margin inside it.
    expect(titleLine).toBe(`┏━ ${title} ━┓`);
    expect(bodyLine).toBe(`┃ ${body} ┃`);
    const bottomLine = plainLine(rendered.lines[rendered.selectable!.bottom - 1]!)
      .slice(horizontal.left, horizontal.right);
    expect(bottomLine).toBe(`┗${"━".repeat(horizontal.panelWidth - 2)}┛`);
    expect(visibleWidth(titleLine)).toBe(horizontal.panelWidth);
    expect(visibleWidth(bodyLine)).toBe(horizontal.panelWidth);
    expect(hitAt(hits, horizontal.contentLeft, top + 2))
      .toEqual({ kind: "list", index: 7 });

    const footerRow = hits.findIndex((row) =>
      row?.overrides?.some((region) => region.target.kind === "action")
    );
    expect(footerRow).toBeGreaterThan(-1);
    expect(hitAt(hits, horizontal.footerLeft, footerRow))
      .toEqual({ kind: "action", action: "cancel" });
  });
});
