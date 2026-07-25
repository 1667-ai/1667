import { describe, expect, test } from "bun:test";
import {
  KEYS_MODAL_MODEL,
  renderKeysOverlay
} from "../src/screens/keys-modal.js";
import { frameText, visibleWidth, type FrameComposition } from "../src/screens/story/frame.js";

function render(width: number, height: number): FrameComposition {
  return renderKeysOverlay(
    Array.from({ length: height }, () => []),
    Array.from({ length: height }, () => null),
    width,
    height
  );
}

describe("spatial keys modal", () => {
  test("renders QWERTY geography and an explicit arrow cluster at both target sizes", () => {
    for (const [width, height] of [[80, 24], [120, 36]] as const) {
      const composition = render(width, height);
      const frame = frameText(composition.lines);

      expect(frame).toContain("┌───┬───┬───┬───┬───┬───┬───┬───┬───┬───┐");
      expect(frame).toContain("│ h │ j │ k │ l │");
      expect(frame).toContain("│ ← │ ↓ │ → │");
      expect(frame).toContain("↑↓ move");
      expect(frame).toContain("←→ takes");
      expect(frame).toContain("l map follow/open");
      expect(frame).toContain("[ enter direct ]");
      expect(frame).toContain("WRITE enter i n new story r w e");
      expect(frame).toContain("␠ continue");
      expect(frame).toContain("⌃↑↓ history");
      expect(frame).toContain("⌃p/: commands · , ?");
      expect(frame).toContain("⌃g wide context details · F rail");
      expect(frame).toContain("q quit · c/C chapters · x menu · y/Y copy · a map detail");
      expect(frame).toContain("R reprompt");
      expect(frame).not.toContain("enter continue");
      expect(frame).toContain("MOVE");
      expect(frame).toContain("WRITE");
      expect(frame).toContain("SHAPE");
      expect(frame).toContain("OPEN");
      expect(frame.toLowerCase()).not.toContain("vi keys");
      for (const line of frame.split("\n")) expect(visibleWidth(line) <= width).toBeTrue();
    }
  });

  test("dims dead navigation caps while keeping l and arrows active", () => {
    const composition = render(80, 24);
    const segments = composition.lines.flat();
    const caps = KEYS_MODAL_MODEL.capRows.flat();

    for (const key of ["h", "j", "k"]) {
      const item = caps.find((candidate) => candidate.key === key)!;
      expect(item.band).toBe("INACTIVE");
      expect(item.bindings).toHaveLength(0);
      expect(segments.some((segment) => segment.text === key && segment.role === "dimmed page")).toBeTrue();
    }

    const follow = caps.find((candidate) => candidate.key === "l")!;
    expect(follow.band).toBe("MOVE");
    expect(follow.label).toBe("map follow/open");
    expect(follow.bindings.map((item) => [item.mode, item.action, item.mapView])).toEqual([
      ["MAP", "map-follow", "tree"],
      ["MAP", "map-follow", "mass"]
    ]);
    expect(segments.some((segment) => segment.text === "l" && segment.role === "focus / accent")).toBeTrue();

    for (const arrow of KEYS_MODAL_MODEL.arrowRows.flat()) {
      expect(arrow.band).toBe("MOVE");
      expect(arrow.bindings.length).toBeGreaterThan(0);
      expect(segments.some((segment) => segment.text === arrow.key && segment.role === "focus / accent")).toBeTrue();
    }
  });

  test("derives bands, arrow copy, utilities, and footer from the diagram", () => {
    expect(KEYS_MODAL_MODEL.bandGroups.map((group) => group.band)).toEqual([
      "MOVE", "WRITE", "SHAPE", "OPEN"
    ]);
    expect(KEYS_MODAL_MODEL.bandGroups.map((group) =>
      group.items.map((item) => [item.token, item.label ?? null])
    )).toEqual([
      [["↑↓", null], ["←→", null], ["g", null], ["u", null], ["l", "map follow/open"]],
      [["enter", null], ["i", null], ["n", "new story"], ["r", null], ["w", null], ["e", null],
        ["⌃↑↓", "history"], ["␠", "continue"]],
      [["d", null], ["b", null], ["p", null], ["z", null], ["s", null]],
      [["m", null], ["f", null], ["o", null], ["⌃p/:", "commands"], [",", null], ["?", null],
        ["⌃g", "wide context details"], ["F", "rail"]]
    ]);
    expect(KEYS_MODAL_MODEL.arrowCopy).toEqual([
      { token: "↑↓", text: "move" },
      { token: "←→", text: "takes" }
    ]);
    expect(KEYS_MODAL_MODEL.discoveries.map((item) => [item.token, item.label])).toEqual([
      ["q", "quit"], ["c/C", "chapters"], ["x", "menu"], ["y/Y", "copy"], ["a", "map detail"],
      ["R", "reprompt"]
    ]);
    expect(KEYS_MODAL_MODEL.discoveries.map((item) => item.bindings.map((binding) => binding.action))).toEqual([
      ["quit"], ["open-chapters", "create-chapter"], ["open-actions"],
      ["copy-part", "copy-line"], ["toggle-path-takes", "toggle-sketches", "toggle-sketches"],
      ["retake-with-prompt"]
    ]);
    expect(KEYS_MODAL_MODEL.utilityCaps.map((item) => [item.key, item.label ?? null])).toEqual([
      ["enter", "direct"], [":", "cmd"], [",", "settings"], ["esc", null]
    ]);
    expect(KEYS_MODAL_MODEL.footer).toBe("↑↓ move · ←→ takes · esc closes");

    const direct = KEYS_MODAL_MODEL.utilityCaps.find((item) => item.key === "enter")!;
    expect(direct.bindings.map((item) => [item.mode, item.action])).toEqual([["NAV", "compose"]]);
    expect(KEYS_MODAL_MODEL.bindings.some((item) =>
      item.name === "space" && item.mode === "NAV" && item.action === "continue"
    )).toBeTrue();
    const newStory = KEYS_MODAL_MODEL.capRows.flat().find((item) => item.key === "n")!;
    expect(newStory.bindings.map((item) => [item.mode, item.action])).toEqual([["NAV", "new-item"]]);

    for (const item of KEYS_MODAL_MODEL.capRows.flat()) {
      if (item.label !== undefined) expect(item.legend?.showLabel).toBeTrue();
    }
  });
});
