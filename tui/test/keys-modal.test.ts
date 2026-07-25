import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { resolveKey, type AppMode } from "../src/keys.js";
import type { MapView } from "../src/map-state.js";
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

function key(name: string, options: { shift?: boolean; ctrl?: boolean } = {}): KeyEvent {
  const shift = options.shift ?? false;
  return {
    name,
    sequence: shift && /^[a-z]$/.test(name) ? name.toUpperCase() : name,
    shift,
    ctrl: options.ctrl ?? false,
    meta: false,
    super: false
  } as KeyEvent;
}

const entries = KEYS_MODAL_MODEL.sections.flatMap((section) => section.entries);

describe("keys reference", () => {
  test("every key it shows is spelled out and every claim resolves", () => {
    expect(entries.length).toBeGreaterThan(30);
    for (const item of entries) {
      expect(`${item.token}:${item.description.length > 0}`).toBe(`${item.token}:true`);
      // An entry without bindings is decoration: it would advertise a key
      // nothing presses, which is the failure the resolver check cannot see.
      expect(`${item.token}:${item.bindings.length > 0}`).toBe(`${item.token}:true`);
      for (const binding of item.bindings) {
        const event = key(binding.name, {
          ...(binding.shift === true ? { shift: true } : {}),
          ...(binding.ctrl === true ? { ctrl: true } : {})
        });
        const resolved = resolveKey(event, binding.mode, {
          ...(binding.mapView === undefined ? {} : { mapView: binding.mapView })
        });
        expect(`${item.token}:${resolved.action}`).toBe(`${item.token}:${binding.action}`);
      }
    }
  });

  test("no reachable story or map key does something the reference never names", () => {
    const explained = new Set(KEYS_MODAL_MODEL.bindings.map((binding) => binding.action));
    const names = [
      ...["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m",
        "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z"],
      "up", "down", "left", "right", "space", "return", "escape",
      "pageup", "pagedown", "[", "]", ":", ",", "?", ";", "/", "."
    ];
    const surfaces: ReadonlyArray<{ mode: AppMode; mapView?: MapView }> = [
      { mode: "NAV" },
      { mode: "MAP", mapView: "path" },
      { mode: "MAP", mapView: "tree" },
      { mode: "MAP", mapView: "mass" }
    ];
    for (const surface of surfaces) {
      for (const name of names) {
        for (const modifiers of [{}, { shift: true }, { ctrl: true }] as const) {
          const resolved = resolveKey(key(name, modifiers), surface.mode, {
            ...(surface.mapView === undefined ? {} : { mapView: surface.mapView })
          });
          if (resolved.action === "none") continue;
          const label = `${surface.mode}/${surface.mapView ?? "-"} ${JSON.stringify(modifiers)}${name}`;
          expect(`${label}:${explained.has(resolved.action)}`).toBe(`${label}:true`);
        }
      }
    }
  });

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
    expect(frame).not.toContain("/27");
    expect(frame).toContain("esc closes");
    expect(render(120, 60, 4).scrollTop).toBe(0);
  });

  test("a short terminal scrolls, clamps, and says where it is", () => {
    const top = render(80, 24);
    const frame = frameText(top.composition.lines);
    expect(top.scrollTop).toBe(0);
    expect(frame).toContain("● MOVE");
    // The range reads the way every other windowed panel's title does.
    expect(frame).toContain("keys · what every key does · 1–15/27");
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
      const shown = `${height}:${frameText(bottom.composition.lines).includes("d / b  prune · bookmark · path")}`;
      expect(shown).toBe(`${height}:true`);
      expect(`${height}:${bottom.scrollTop + painted}`).toBe(`${height}:27`);
      expect(frameText(bottom.composition.lines))
        .toContain(`${bottom.scrollTop + 1}–${bottom.scrollTop + painted}/27`);
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

  test("descriptions stay inside the column budget instead of truncating", () => {
    const frame = text(80, 36);
    expect(frame).not.toContain("…");
    for (const item of entries) expect(visibleWidth(item.description) <= 24).toBeTrue();
  });
});
