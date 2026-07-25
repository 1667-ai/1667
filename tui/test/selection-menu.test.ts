import { expect, test } from "bun:test";
import { MouseEvent } from "@opentui/core";
import { selectionAwarePartMenuAction } from "../src/selection-menu.js";
import type { StorySelectionProjection } from "../src/selection-projection.js";

function rightClick(): MouseEvent {
  return new MouseEvent(null, {
    type: "down",
    button: 2,
    x: 12,
    y: 4,
    modifiers: { shift: false, alt: false, ctrl: false }
  });
}

test("a part menu captures and preserves the active OpenTUI selection", () => {
  const event = rightClick();
  const source = "only these words";
  let clearCount = 0;
  const projection: StorySelectionProjection = [
    ...[...source].map((_, index) => ({
      key: "part:text", text: source, start: index, end: index + 1
    }))
  ];
  const resolved = selectionAwarePartMenuAction(
    event,
    { action: "open-actions", index: 3 },
    { getSelection: () => ({
      getSelectedText: () => "gutter only these words padding",
      selectedRenderables: [{ getSelection: () => ({ start: 0, end: source.length }) }]
    }) as never, clearSelection: () => { clearCount += 1; } },
    projection
  );

  expect(resolved).toEqual({
    action: "open-actions",
    index: 3,
    selectionText: "only these words",
    selectionSpans: [{ key: "part:text", text: source, start: 0, end: source.length }]
  });
  expect(event.defaultPrevented).toBeTrue();
  expect(clearCount).toBe(1);
});

test("ordinary part menus keep their whole-part copy fallback", () => {
  const event = rightClick();
  const resolved = selectionAwarePartMenuAction(
    event,
    { action: "open-actions", index: 3 },
    { getSelection: () => null, clearSelection: () => false }
  );

  expect(resolved).toEqual({ action: "open-actions", index: 3 });
  expect(event.defaultPrevented).toBeFalse();
});

test("finishing a prose drag does not refocus and reflow its selection", () => {
  const event = new MouseEvent(null, {
    type: "up", button: 0, x: 12, y: 4,
    modifiers: { shift: false, alt: false, ctrl: false }
  });
  const resolved = selectionAwarePartMenuAction(
    event,
    { action: "focus-index", index: 3 },
    {
      getSelection: () => ({ getSelectedText: () => "dragged prose" }) as never,
      clearSelection: () => false
    }
  );

  expect(resolved).toBe(null);
});
