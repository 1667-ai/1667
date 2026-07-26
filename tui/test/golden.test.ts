import { describe, expect, test } from "bun:test";
import { renderOnce } from "../src/app.js";
import { demoAppSource } from "../src/demo.js";

const demoSource = demoAppSource;

describe("deterministic demo frames", () => {
  test("120x36 keeps the broadside gutter and status landmarks", async () => {
    const frame = await renderOnce(demoSource(), 120, 36);
    expect(frame).toContain("                     ×2 Maren counted");
    expect(frame).toContain("○ ○ ● ○ ○");
    expect(frame).toContain("esc stops");
    expect(frame).toContain("CHAPTER THREE · The Compass · parts 11–13");
    expect(frame).toContain("NAV   the lantern keeper · ⚑ canon-storm · part 12/13 · take 3/5 · 307 words");

    const lines = frame.split("\n");
    const partLine = lines.find((line) => line.includes("Maren counted"));
    const actionLine = lines.find((line) => line.includes("␠ continue"));
    const statusLine = lines.find((line) => line.includes("NAV   the lantern keeper"));
    expect(partLine?.indexOf("×2")).toBe(21);
    expect(partLine?.indexOf("Maren counted")).toBe(24);
    expect(actionLine?.indexOf("␠ continue")).toBe(1);
    expect(statusLine?.startsWith(" NAV")).toBeTrue();
  });

  test("80x24 folds state into boundary rules", async () => {
    const frame = await renderOnce(demoSource(), 80, 24);
    expect(frame).toContain("── ¶ 12 · ‹ take 3/5 ›");
    expect(frame).toContain("── ¶ 13 · ⟳ writing · esc stops");
    expect(frame).toContain("space continues · enter directs · n new story · m map");
    expect(frame).toContain("NAV   the lantern keeper · ⚑ canon-storm · ¶ 12/13 · 3/5");
    expect(frame).not.toContain("307 words");
  });

  test("m opens a full-bleed MAP path with no story page or scrim behind it", async () => {
    const frame = await renderOnce(demoSource(), 120, 36, "m");
    expect(frame.startsWith("━━ map ·  path   tree   mass")).toBeTrue();
    expect(frame).toContain("the lantern keeper ━ 23 parts on 4 lines · 4 bookmarks");
    expect(frame).not.toContain("sketches folded");
    expect(frame).toContain("take 3/5");
    expect(frame).toContain("depth 1–13 of 13");
    expect(frame).toContain("He did not move toward the stairs.");
    expect(frame).toContain("⚑ canon-storm");
    expect(frame).toContain("MAP  path/all");
    expect(frame).toContain("m tree · a branches · ↑↓ depth · ←→ take · enter · esc");
    expect(frame).not.toContain("┏━");
    expect(frame).not.toContain("CHAPTER THREE");
    expect(frame).not.toContain("␠ continue");
  });

  test("a second m cycles MAP to the tree graph at 120x36", async () => {
    const source = demoSource();
    const frame = await renderOnce(source, 120, 36, "mm");
    const leaf = source.payload.path.at(-1)!;
    const bookmark = source.payload.bookmarks.find((item) => item.nodeId === leaf.id)!;
    expect(frame.startsWith("━━ map ·  path   tree   mass")).toBeTrue();
    expect(frame).toContain("4 lines · 23 parts · 5 forks");
    // The reading line is the trunk at column 0; revealed alternates share its branch.
    expect(frame).toContain("│ ·· 1 part");
    expect(frame).toContain("│ ├─○ ¶8  ✕ burned");
    expect(frame).not.toContain("┼");
    expect(frame).not.toContain("│ │");
    expect(frame).toContain("×1 line · cold 8 wks");
    expect(frame).toContain("+ 7 sketches revealed · a hides");
    expect(frame).toContain(`⚑ ${bookmark.name}`);
    expect(frame).toContain(`¶${source.payload.path.length}`);
    expect(frame).toContain("‥ Outside, the storm leaned on the shutters");
    expect(frame).toContain("MAP  tree");
    expect(frame).toContain("m mass · ↑↓ row · l follow · enter · esc writes");
    expect(frame).not.toContain("┏━");
  });

  test("MAP tree at 80x24 preserves graph structure and drops the preview", async () => {
    const source = demoSource();
    const frame = await renderOnce(source, 80, 24, "mm");
    const leaf = source.payload.path.at(-1)!;
    const bookmark = source.payload.bookmarks.find((item) => item.nodeId === leaf.id)!;
    expect(frame.startsWith("━━ map ·  path   tree   mass")).toBeTrue();
    // Narrow keeps the same shape — one trunk, `└─` stubs, never a wall of rails.
    expect(frame).toContain("│ └─○");
    expect(frame).not.toContain("│ │");
    expect(frame).not.toContain("┼");
    expect(frame).toContain(`¶${source.payload.path.length}`);
    expect(frame).toContain(`⚑ ${bookmark.name}`);
    expect(frame).toContain("↑ 10 earlier");
    expect(frame).toContain("7 sketches revealed · a hides");
    expect(frame).toContain("m mass · ↑↓ row · l follow · esc");
    expect(frame).not.toContain("‥ Outside");
    expect(frame).not.toContain("enter reroute");
  });

  test("a third m promotes MAP mass with weighted lines and sketch hairline", async () => {
    const source = demoSource();
    const frame = await renderOnce(source, 120, 36, "mmm");
    const activeBookmark = source.payload.bookmarks.find((bookmark) => bookmark.nodeId === source.payload.path.at(-1)?.id)!;
    expect(frame.startsWith("━━ map ·  path   tree   mass")).toBeTrue();
    expect(frame).toContain("by word count · 653 words across 4 lines");
    for (const bookmark of source.payload.bookmarks) expect(frame).toContain(bookmark.name);
    expect(frame).toContain("▸◉ ⚑ canon-storm");
    expect(frame).toContain("307 w  13 parts  ← here");
    expect(frame).toContain(`⚑ ${activeBookmark.name}`);
    expect(frame).toContain("…7 sketches");
    expect(frame).toContain("never continued");
    expect(frame).toContain("sort: size · recent · depth · alpha");
    expect(frame).toContain("‥ Outside, the storm leaned on the shutters");
    expect(frame).toContain("m path · ↑↓ row · s sort · l open · esc writes");
    expect(frame).not.toContain("trunk ¶");
    expect(frame).not.toContain("┏━");
  });

  test("MAP mass at 80x24 keeps identity, bars, sorting, and arrow navigation", async () => {
    const frame = await renderOnce(demoSource(), 80, 24, "mmm");
    expect(frame.startsWith("━━ map ·  path   tree   mass")).toBeTrue();
    expect(frame).toContain("▸◉ ⚑ canon-storm");
    expect(frame).toContain("307 w  13p  ← here");
    expect(frame).toContain("…7 sketches");
    expect(frame).toContain("never continued");
    expect(frame).toContain("sort: size · recent · depth · alpha");
    expect(frame).toContain("m path · ↑↓ row · s sort · l open · esc");
    expect(frame).not.toContain("‥ Outside");
    expect(frame).not.toContain("enter reroute");
    expect(frame).not.toContain("j scrolls");
  });

  test("MAP path exposes prune confirmation in its bottom breadcrumb", async () => {
    const frame = await renderOnce(demoSource(), 120, 36, "\u001bmd");
    expect(frame.startsWith("━━ map ·  path   tree   mass")).toBeTrue();
    expect(frame).toContain("PRUNE   ⚑ canon-storm · ¶ 12 take 3/5 → 2 parts on 1 line die");
    expect(frame).toContain("d confirms · esc keeps");
  });

  test("? explains every key it shows, in sections rather than a keyboard", async () => {
    const frame = await renderOnce(demoSource(), 120, 36, "?");
    expect(frame).toContain("┏━ keys · and what they do ━");
    expect(frame).toContain("● MOVE  read and navigate");
    expect(frame).toContain("↑ ↓  previous · next row");
    expect(frame).toContain("← →  flip between takes");
    expect(frame).toContain("l  follow tree · open mass");
    expect(frame).toContain("s  tree→mass · mass sorts");
    expect(frame).not.toContain("│ ↑ │");
    expect(frame).not.toContain("j/k");
    expect(frame).not.toContain("h/l");
    expect(frame).toContain("KEYS   the lantern keeper");
  });

  test("compose enters an accent-framed field with contextual controls", async () => {
    const frame = await renderOnce(demoSource(), 120, 36, "\u001bi");
    expect(frame).toContain("┏━ compose · ¶ 12 ━");
    expect(frame).toContain("┃ ›  direct the take…");
    expect(frame).toContain("┗━ enter send · ⇧enter newline · ⌃f fullscreen · esc nav");
    expect(frame).toContain("COMPOSE   the lantern keeper");
  });

  test("--keys toggles persistent typewriter status", async () => {
    const frame = await renderOnce(demoSource(), 120, 36, "z");
    expect(frame).toContain("local ✓ · z centered");
  });
});
