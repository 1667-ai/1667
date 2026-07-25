import { describe, expect, test } from "bun:test";
import { createAtlasLayout } from "../src/atlas-layout.js";
import { createDemoController } from "../src/demo.js";
import type { MapMassSort } from "../src/map-state.js";
import {
  createMapMassScale,
  renderMapMassRow,
  renderMapSketchHairline
} from "../src/screens/map-mass-row.js";
import { formatMapWords } from "../src/screens/map-row-labels.js";
import { plainLine, visibleWidth } from "../src/screens/story/frame.js";

const NOW = 1_667_000_000_000;

describe("MAP mass rows", () => {
  test("formats mass counts in compact k form", () => {
    expect(formatMapWords(31_204)).toBe("31.2k");
    expect(formatMapWords(999)).toBe("999 w");
  });

  test("orders line rows by size, recency, depth, and name", () => {
    const payload = createDemoController().payload();
    const touched = new Map([
      ["p13", "2022-10-22T09:00:00.000Z"], ["p11-alt", "2022-10-25T09:00:00.000Z"],
      ["p8-alt-3", "2022-10-23T09:00:00.000Z"], ["p5-alt", "2022-10-24T09:00:00.000Z"]
    ]);
    payload.nodes = payload.nodes.map((node) => touched.has(node.id)
      ? { ...node, lastTouched: touched.get(node.id)! }
      : node);
    const expected: Record<MapMassSort, string[]> = {
      size: ["canon-storm", "alt-quiet-inn", "burned", "draft-ledger"],
      recency: ["alt-quiet-inn", "draft-ledger", "burned", "canon-storm"],
      depth: ["canon-storm", "alt-quiet-inn", "burned", "draft-ledger"],
      name: ["alt-quiet-inn", "burned", "canon-storm", "draft-ledger"]
    };
    for (const sort of ["size", "recency", "depth", "name"] as const) {
      const names = createAtlasLayout(payload, { now: NOW, sort }).allRows
        .map((row) => row.bookmark?.name ?? "");
      expect(names).toEqual(expected[sort]);
    }

    const bookmarks = new Set(payload.bookmarks.map((bookmark) => bookmark.nodeId));
    const active = new Set(payload.path.map((node) => node.id));
    payload.nodes = payload.nodes.map((node) => node.childCount === 0 && !bookmarks.has(node.id) && !active.has(node.id)
      ? { ...node, lastTouched: "2022-10-30T09:00:00.000Z" }
      : node);
    const revealed = createAtlasLayout(payload, { now: NOW, sort: "recency", showSketches: true });
    const firstSketch = revealed.allRows.findIndex((row) => row.kind === "sketch");
    expect(revealed.allRows.slice(0, firstSketch).every((row) => row.lineEnd)).toBeTrue();
    expect(revealed.allRows.slice(firstSketch).every((row) => row.kind === "sketch")).toBeTrue();
  });

  test("scales bars to the largest line and keeps non-zero lines visible", () => {
    const payload = createDemoController().payload();
    const layout = createAtlasLayout(payload, { now: NOW, sort: "size" });
    const width = 120;
    const scale = createMapMassScale(layout, width);
    const barCells = new Map(layout.allRows.map((row) => {
      const rendered = renderMapMassRow(row, scale);
      expect(rendered.every((part) => part.background === undefined)).toBeTrue();
      const field = rendered[4]!.text;
      const cells = field.match(/^█+/)?.[0].length ?? 0;
      const expected = Math.max(1, Math.round(row.words / layout.massMaximum * visibleWidth(field)));
      expect(cells).toBe(expected);
      return [row.id, cells];
    }));
    expect(Math.max(...barCells.values())).toBeGreaterThan(0);

    const smallest = layout.allRows.at(-1)!;
    const scrolled = createAtlasLayout(payload, {
      now: NOW,
      sort: "size",
      cursorId: smallest.id,
      maxRows: 1
    });
    const scrolledBar = renderMapMassRow(scrolled.rows[0]!, createMapMassScale(scrolled, width))[4]!.text;
    expect(scrolled.massMaximum).toBe(layout.massMaximum);
    expect(scrolledBar.match(/^█+/)?.[0].length ?? 0).toBe(barCells.get(smallest.id));
  });

  test("keeps the cursor visible when it coincides with the current line", () => {
    const payload = createDemoController().payload();
    const currentId = payload.path.at(-1)!.id;
    const layout = createAtlasLayout(payload, { now: NOW, sort: "size", cursorId: currentId });
    const current = layout.allRows.find((row) => row.id === currentId)!;
    expect(current).toMatchObject({ active: true, cursor: true });
    for (const width of [80, 120]) {
      const rendered = renderMapMassRow(current, createMapMassScale(layout, width));
      expect(rendered[1]).toMatchObject({ text: "▸◉ ", role: "focus / accent" });
      expect(visibleWidth(plainLine(rendered)) <= width).toBeTrue();
    }
  });

  test("uses one bar scale when active and metadata widths differ", () => {
    const payload = createDemoController().payload();
    const ownWords = new Map([
      ["p13", 10_000_022],
      ["p11-alt", 10_000_140],
      ["p8-alt-3", 10_000_210]
    ]);
    payload.nodes = payload.nodes.map((node) => ownWords.has(node.id)
      ? { ...node, words: ownWords.get(node.id)! }
      : node);
    const layout = createAtlasLayout(payload, { now: NOW, sort: "size" });
    const rows = layout.allRows.slice(0, 3);
    expect(rows.map((row) => row.words)).toEqual([10_000_307, 10_000_301, 10_000_300]);
    expect(rows[0]).toMatchObject({ active: true, depth: 13 });
    expect(rows[2]!.depth).toBe(8);

    for (const width of [80, 120]) {
      const scale = createMapMassScale(layout, width);
      expect(scale.wordsWidth).toBeGreaterThan(6);
      const rendered = rows.map((row) => renderMapMassRow(row, scale));
      expect(rendered.every((line) => visibleWidth(plainLine(line)) <= width)).toBeTrue();
      expect(plainLine(rendered[0]!)).toContain("10000.3k");
      const fields = rendered.map((line) => line[4]!.text);
      expect(new Set(fields.map(visibleWidth))).toEqual(new Set([scale.barWidth]));
      const cells = fields.map((field) => field.match(/^█+/)?.[0].length ?? 0);
      expect(cells[0]).toBe(scale.barWidth);
      expect(cells[0]! >= cells[1]!).toBeTrue();
      expect(cells[1]! >= cells[2]!).toBeTrue();
    }
  });

  test("caps revealed sketches to the MAP bar field", () => {
    const layout = createAtlasLayout(createDemoController().payload(), {
      now: NOW,
      sort: "size",
      showSketches: true
    });
    const scale = createMapMassScale(layout, 80);
    for (const row of layout.allRows) {
      const rendered = renderMapMassRow(row, scale);
      expect(visibleWidth(plainLine(rendered)) <= 80).toBeTrue();
      expect((rendered[4]!.text.match(/^█+/)?.[0].length ?? 0) <= visibleWidth(rendered[4]!.text)).toBeTrue();
    }
  });

  test("draws the folded-sketch hairline and revealed sketch rows", () => {
    const payload = createDemoController().payload();
    const layout = createAtlasLayout(payload, { now: NOW, sort: "size" });
    const hairline = renderMapSketchHairline(layout, 80);
    expect(plainLine(hairline)).toContain(`${layout.sketchCount} sketches`);
    expect(plainLine(hairline)).toContain("▏".repeat(layout.sketchCount));
    expect(plainLine(hairline)).toContain("never continued");
    expect(hairline.every((part) => part.background === undefined)).toBeTrue();

    const revealed = createAtlasLayout(payload, { now: NOW, sort: "size", showSketches: true });
    const sketches = revealed.rows.filter((row) => row.kind === "sketch");
    expect(sketches.length).toBe(layout.sketchCount);
    const scale = createMapMassScale(revealed, 80);
    expect(sketches.map((row) => plainLine(renderMapMassRow(row, scale))).join("\n")).toContain("“");
  });
});
