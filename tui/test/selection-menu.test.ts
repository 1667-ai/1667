import { expect, test } from "bun:test";
import { MouseEvent } from "@opentui/core";
import {
  selectionAwarePartMenuAction,
  selectionAwareTextMenuAction
} from "../src/selection-menu.js";
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

test("an editor menu freezes and clears the native selection before repaint", () => {
  const event = rightClick();
  const native = {
    getSelectedText: () => "selected draft",
    anchor: { x: 14, y: 2 },
    focus: { x: 0, y: 2 },
    selectedRenderables: [{ getSelection: () => ({ start: 0, end: 14 }) }]
  } as never;
  let clearCount = 0;
  const projection = Array.from({ length: 14 }, (_, index) => ({
    start: index,
    end: index + 1
  }));

  const resolved = selectionAwareTextMenuAction(
    event,
    { action: "open-text-actions" },
    {
      getSelection: () => native,
      clearSelection: () => { clearCount += 1; }
    },
    projection
  );

  expect(resolved).toEqual({
    action: "open-text-actions",
    nativeSelection: {
      identity: native,
      text: "selected draft",
      range: { start: 0, end: 14 },
      backward: true
    },
    composerSelectionProjection: projection
  });
  expect(event.defaultPrevented).toBeTrue();
  expect(clearCount).toBe(1);
});

test("an editor menu leaves an unrelated native selection untouched", () => {
  const event = rightClick();
  let clearCount = 0;
  const resolved = selectionAwareTextMenuAction(
    event,
    { action: "open-text-actions" },
    {
      getSelection: () => ({
        getSelectedText: () => "story chrome",
        anchor: { x: 0, y: 0 },
        focus: { x: 12, y: 0 },
        selectedRenderables: [{ getSelection: () => ({ start: 0, end: 12 }) }]
      }) as never,
      clearSelection: () => { clearCount += 1; }
    },
    [null]
  );

  expect(resolved).toEqual({ action: "open-text-actions" });
  expect(event.defaultPrevented).toBeTrue();
  expect(clearCount).toBe(0);
});

test("a mixed editor selection stays selected and does not open a menu", () => {
  const event = rightClick();
  let clearCount = 0;
  const resolved = selectionAwareTextMenuAction(
    event,
    { action: "open-text-actions" },
    {
      getSelection: () => ({
        getSelectedText: () => "tagbody",
        anchor: { x: 0, y: 0 },
        focus: { x: 7, y: 0 },
        selectedRenderables: [{ getSelection: () => ({ start: 0, end: 7 }) }]
      }) as never,
      clearSelection: () => { clearCount += 1; }
    },
    [
      ...Array.from({ length: 3 }, (_, index) => ({
        start: index,
        end: index + 1,
        sourceId: "fact-tag"
      })),
      ...Array.from({ length: 4 }, (_, index) => ({
        start: index,
        end: index + 1,
        sourceId: "fact-body"
      }))
    ]
  );

  expect(resolved).toBe(null);
  expect(event.defaultPrevented).toBeTrue();
  expect(clearCount).toBe(0);
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
