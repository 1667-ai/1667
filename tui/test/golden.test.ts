import { describe, expect, test } from "bun:test";
import { renderOnce } from "../src/app.js";
import { demoAppSource } from "../src/demo.js";

const demoSource = demoAppSource;

describe("deterministic demo frames", () => {
  test("Author's Note editor keeps its component grammar at 120 and 80 columns", async () => {
    for (const width of [120, 80]) {
      const shortSource = demoSource();
      shortSource.payload = await shortSource.api.setAuthorsNote(
        shortSource.payload.id,
        "Keep the prose spare."
      );
      const shortFrame = await renderOnce(shortSource, width, 24, "\u001bn");
      expect(shortFrame.startsWith("┏━ author's note ")).toBeTrue();
      expect(shortFrame).toContain("Keep the prose spare.");
      expect(shortFrame).not.toContain("tokens — long");
      expect(shortFrame).toContain("ctrl+s save · esc cancel");

      const warningSource = demoSource();
      warningSource.payload = await warningSource.api.setAuthorsNote(
        warningSource.payload.id,
        "x".repeat(1_204)
      );
      const warningFrame = await renderOnce(warningSource, width, 24, "\u001bn");
      expect(warningFrame.startsWith("┏━ author's note ")).toBeTrue();
      expect(warningFrame).toContain("· 301 tokens — a long note crowds the prose it steers");
      expect(warningFrame.split("\n").every((line) => line.length <= width)).toBeTrue();
    }
  });

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
    expect(frame).toContain("── ¶ 13 ·");
    expect(frame).toContain("writing · esc stops");
    expect(frame).toContain("space continues · enter directs · a aside · n note · m map");
    expect(frame).toContain("NAV   the lantern keeper · ⚑ canon-storm · ¶ 12/13 · 3/5");
    expect(frame).not.toContain("307 words");
  });

  test("/ renders a full-bleed SEARCH answered in the same frame", async () => {
    // renderOnce sends its keys and captures at once, so this also pins that a
    // fixture answering from memory never waits out a pause it does not need.
    const frame = await renderOnce(demoSource(), 120, 36, "/compass");
    expect(frame.startsWith("━━ search ━ ⌕ compass")).toBeTrue();
    expect(frame).toContain("hits in");
    expect(frame).not.toContain("searching…");
    expect(frame).toContain("· this line");
    expect(frame).toContain("↵ reroute + jump");
    expect(frame).not.toContain("␠ continue");

    const lines = frame.split("\n");
    const hit = lines.find((line) => line.includes("compass") && line.includes("¶"))!;
    // The doc 17a grid: focus rail column 0, ¶ ref at column 4, divider at 58.
    expect(hit.indexOf("¶")).toBe(4);
    expect(hit[58]).toBe("│");
  });

  test("m opens a full-bleed MAP path with no story page or scrim behind it", async () => {
    const frame = await renderOnce(demoSource(), 120, 36, "m");
    expect(frame.startsWith("━━ map ·  path   tree   mass")).toBeTrue();
    expect(frame).toContain("the lantern keeper ━ 23 parts on 4 lines · 4 tags");
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

  test("a second m cycles MAP to the tree lanes at 120x36", async () => {
    const source = demoSource();
    const frame = await renderOnce(source, 120, 36, "mm");
    const leaf = source.payload.path.at(-1)!;
    const tag = source.payload.tags.find((item) => item.nodeId === leaf.id)!;
    expect(frame.startsWith("━━ map ·  path   tree   mass")).toBeTrue();
    expect(frame).toContain("4 lines · 23 parts · 5 forks");
    // Doc "10a": the whole tree draws in lanes now — box-drawing is the
    // picture itself, not a defect the old local-camera graph avoided.
    expect(frame).toContain("├─╮");
    expect(frame).toContain("│");
    expect(frame).toContain("╵");
    expect(frame).not.toContain("↳");
    expect(frame).toContain("×1 line · cold 8 wks");
    // `openMap` starts with sketches revealed, so folds never draw here.
    // The word count is cumulative from the root, the same number mass gives
    // this line — not the 13 words along the off-path segment alone.
    expect(frame).toContain("✕ burned · 103w");
    expect(frame).toMatch(/○ .*‥”/);
    expect(frame).toContain(`⚑ ${tag.name}`);
    expect(frame).toContain("‥ Outside, the storm leaned on the shutters");
    expect(frame).toContain("MAP  tree");
    expect(frame).toContain("m mass · ↑↓ row · ←→ lane · a sketches · tab path · enter · esc writes");
    expect(frame).not.toContain("┏━");
  });

  test("MAP tree at 80x24 draws the lanes and drops the preview", async () => {
    const source = demoSource();
    const frame = await renderOnce(source, 80, 24, "mm");
    const leaf = source.payload.path.at(-1)!;
    const tag = source.payload.tags.find((item) => item.nodeId === leaf.id)!;
    expect(frame.startsWith("━━ map ·  path   tree   mass")).toBeTrue();
    // Narrow keeps the same shape — a fixed gutter of lanes, no `↳` stubs.
    expect(frame).toContain("├─╮");
    expect(frame).not.toContain("↳");
    expect(frame).toContain(`⚑ ${tag.name}`);
    expect(frame).toContain("▲ 15 above");
    expect(frame).toMatch(/○ .*‥”/);
    expect(frame).toContain("m mass · ↑↓ row · ←→ lane · tab path · esc");
    expect(frame).not.toContain("‥ Outside");
    expect(frame).not.toContain("enter reroute");
  });

  test("a third m promotes MAP mass with weighted lines and sketch hairline", async () => {
    const source = demoSource();
    const frame = await renderOnce(source, 120, 36, "mmm");
    const activeTag = source.payload.tags.find((tag) => tag.nodeId === source.payload.path.at(-1)?.id)!;
    expect(frame.startsWith("━━ map ·  path   tree   mass")).toBeTrue();
    // Doc 26a: the header counts the story once. The old sum of each line's
    // cumulative words charged the shared trunk to every line and read 653.
    expect(frame).toContain("466 words · 4 lines ━ largest first");
    expect(frame).not.toContain("653 words");
    for (const tag of source.payload.tags) expect(frame).toContain(tag.name);
    expect(frame).toContain("▸ ◉ canon-storm");
    expect(frame).toContain("307  13 parts  ← here");
    expect(frame).toContain(`⚑ ${activeTag.name}`);
    expect(frame).toContain("…7 sketches");
    expect(frame).toContain("never continued");
    // The in-canvas sort row is gone; the footer is the only place it lives.
    expect(frame).not.toContain("sort: ");
    expect(frame).toContain("‥ Outside, the storm leaned on the shutters");
    expect(frame).toContain("m path · ↑↓ row · s sort · l open · esc writes");
    expect(frame).not.toContain("trunk ¶");
    expect(frame).not.toContain("┏━");
  });

  test("MAP mass at 80x24 keeps identity, bars, sorting, and arrow navigation", async () => {
    const frame = await renderOnce(demoSource(), 80, 24, "mmm");
    expect(frame.startsWith("━━ map ·  path   tree   mass")).toBeTrue();
    expect(frame).toContain("▸ ◉ canon-storm");
    expect(frame).toContain("307  13p      ← here");
    expect(frame).toContain("…7 sketches");
    expect(frame).toContain("never continued");
    expect(frame).not.toContain("sort: ");
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
    expect(frame).toContain("s  sort the mass view");
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
    expect(frame).toContain("qwen3-32b · z centered");
  });
});
