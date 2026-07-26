import { describe, expect, test } from "bun:test";
import {
  KEYS_MODAL_MODEL,
  renderKeysOverlay,
  type KeysOverlayRender
} from "../src/screens/keys-modal.js";
import { frameText, visibleWidth } from "../src/screens/story/frame.js";

function render(width: number, height: number, scrollTop = 0): KeysOverlayRender {
  return renderKeysOverlay(
    Array.from({ length: height }, () => []),
    Array.from({ length: height }, () => null),
    width,
    height,
    scrollTop
  );
}

function text(width: number, height: number, scrollTop = 0): string {
  return frameText(render(width, height, scrollTop).composition.lines);
}

const entries = KEYS_MODAL_MODEL.sections.flatMap((section) => section.entries);

describe("keys reference", () => {
  test("sections read in a fixed order and each explains itself", () => {
    expect(KEYS_MODAL_MODEL.sections.map((section) => section.title)).toEqual([
      "MOVE", "WRITE", "SHAPE", "OPEN", "MAP"
    ]);
    const frame = text(120, 36);
    for (const section of KEYS_MODAL_MODEL.sections) {
      expect(frame).toContain(`● ${section.title}  ${section.blurb}`);
    }
  });

  test("keys and meanings sit side by side, wide and narrow", () => {
    for (const [width, height] of [[80, 36], [120, 36]] as const) {
      const frame = text(width, height);
      expect(frame).toContain("space  continue this part");
      expect(frame).toContain("r  retake · same prompt");
      expect(frame).toContain("m  map of the whole story");
      expect(frame).toContain("↑ ↓  move between parts");
      expect(frame).toContain("esc  close what is open");
      for (const line of frame.split("\n")) expect(visibleWidth(line) <= width).toBeTrue();
    }
  });

  test("the old QWERTY diagram and its unexplained bands are gone", () => {
    const frame = text(120, 36);
    expect(frame).not.toContain("┌───┬───┬───┬───┬───┬───┬───┬───┬───┬───┐");
    expect(frame).not.toContain("│ h │ j │ k │ l │");
    expect(frame).not.toContain("MORE");
    expect(frame.toLowerCase()).not.toContain("laid where your fingers are");
  });

  test("columns follow the width the panel actually has", () => {
    const headingsPerRow = (width: number, height: number): number => Math.max(
      ...text(width, height).split("\n").map((line) => (line.match(/● /g) ?? []).length)
    );
    expect(headingsPerRow(120, 36)).toBe(3);
    expect(headingsPerRow(80, 36)).toBe(2);
    expect(headingsPerRow(52, 60)).toBe(1);
  });

  test("a tall terminal shows the whole reference and offers no scroll", () => {
    const frame = text(120, 60);
    for (const item of entries) expect(frame).toContain(`  ${item.description}`);
    expect(frame).not.toContain("scrolls");
    expect(frame).not.toContain("/29");
    expect(frame).toContain("esc closes");
    expect(render(120, 60, 4).scrollTop).toBe(0);
  });

  test("a short terminal scrolls, clamps, and says where it is", () => {
    const top = render(80, 24);
    const frame = frameText(top.composition.lines);
    expect(top.scrollTop).toBe(0);
    expect(frame).toContain("● MOVE");
    // The range reads the way every other windowed panel's title does.
    expect(frame).toContain("keys · and what they do · 1–15/29");
    expect(frame).toContain("↑↓ scrolls · esc closes");

    const scrolled = render(80, 24, 8);
    expect(scrolled.scrollTop).toBe(8);
    expect(frameText(scrolled.composition.lines)).not.toContain("● MOVE");

    // Held arrows must land on the last row rather than scrolling into blank.
    const clamped = render(80, 24, 500);
    expect(clamped.scrollTop).toBeLessThan(500);
    expect(frameText(clamped.composition.lines)).toContain("q  quit 1667");
    expect(render(80, 24, clamped.scrollTop + 1).scrollTop).toBe(clamped.scrollTop);
  });

  test("the last row stays reachable on the shortest panel the frame allows", () => {
    // `placePanel` floors its own height, so a taller slice than it paints
    // would strand the final rows and overstate the footer's position.
    for (const height of [10, 11, 12, 13, 16]) {
      const bottom = render(80, height, 500);
      const painted = frameText(bottom.composition.lines)
        .split("\n")
        .filter((line) => line.includes("┃")).length - 1;
      // The note is the last row by construction: reaching it proves the bound.
      const shown = `${height}:${frameText(bottom.composition.lines).includes("chapter rows differ")}`;
      expect(shown).toBe(`${height}:true`);
      expect(`${height}:${bottom.scrollTop + painted}`).toBe(`${height}:29`);
      expect(frameText(bottom.composition.lines))
        .toContain(`${bottom.scrollTop + 1}–${bottom.scrollTop + painted}/29`);
    }
  });

  test("a map key that only works in some views names them", () => {
    // `d` prunes in path and does nothing in tree or mass. A section headed
    // "while the map is open" would otherwise promise all three.
    const map = KEYS_MODAL_MODEL.sections.find((section) => section.title === "MAP")!;
    for (const item of map.entries) {
      const views = new Set(item.bindings.map((binding) => binding.mapView));
      if (views.has(undefined) || views.size === 3) continue;
      for (const view of views) {
        expect(`${item.token}:${item.description.includes(view!)}`).toBe(`${item.token}:true`);
      }
    }
  });

  test("it says where a chapter row's own keys are named", () => {
    // `directChapterRowAction` runs before NAV, so `e` renames a chapter and
    // `d` removes its break. The reference points at the story's hint line
    // rather than claiming one meaning for both.
    for (const [width, height] of [[80, 60], [120, 60]] as const) {
      expect(text(width, height)).toContain("chapter rows differ · the line under the story says how");
    }
  });

  test("descriptions stay inside the column budget instead of truncating", () => {
    const frame = text(80, 36);
    expect(frame).not.toContain("…");
    for (const item of entries) expect(visibleWidth(item.description) <= 24).toBeTrue();
  });
});
