import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { ActionRuntime } from "../src/action-runtime.js";
import { initialState } from "../src/app.js";
import { demoAppSource } from "../src/demo.js";
import { resolveKey, type AppMode } from "../src/keys.js";
import type { MapView } from "../src/map-state.js";
import { mouseToAction } from "../src/mouse-actions.js";
import { handleOverlayAction } from "../src/overlay-actions.js";
import { KEYS_MODAL_MODEL } from "../src/screens/keys-modal.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { createWrapCache } from "../src/wrap.js";

function key(name: string, options: { shift?: boolean; ctrl?: boolean } = {}): KeyEvent {
  const shift = options.shift ?? false;
  const resolvedName = shift && /^[a-z]$/.test(name) ? name.toUpperCase() : name;
  return {
    name: resolvedName,
    sequence: resolvedName,
    shift,
    ctrl: options.ctrl ?? false,
    meta: false,
    super: false
  } as KeyEvent;
}

const entries = KEYS_MODAL_MODEL.sections.flatMap((section) => section.entries);

describe("keys reference contract", () => {
  test("every advertised binding has copy and resolves exactly", () => {
    expect(entries.length).toBeGreaterThan(30);
    for (const item of entries) {
      expect(item.description.length).toBeGreaterThan(0);
      expect(item.bindings.length).toBeGreaterThan(0);
      const displays = [...new Set(item.bindings.map((binding) => binding.display))];
      expect(item.token).toBe(displays.join(" "));
      for (const binding of item.bindings) {
        expect(binding.display.length).toBeGreaterThan(0);
        const event = key(binding.name, {
          ...(binding.shift === true ? { shift: true } : {}),
          ...(binding.ctrl === true ? { ctrl: true } : {})
        });
        expect(resolveKey(event, binding.mode, { mapView: binding.mapView }).action)
          .toBe(binding.action);
      }
    }
  });

  test("every reachable story and map gesture has one concrete reference binding", () => {
    const letters = [
      "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m",
      "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z"
    ];
    const names = [
      ...letters,
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
      const events = [
        ...names.map((name) => key(name)),
        ...(surface.mode === "NAV"
          ? [
              ...letters.map((name) => key(name, { shift: true })),
              key("up", { shift: true }),
              key("down", { shift: true }),
              ...letters.map((name) => key(name, { ctrl: true }))
            ]
          : [])
      ];
      for (const event of events) {
        const resolved = resolveKey(event, surface.mode, { mapView: surface.mapView });
        if (resolved.action === "none") continue;
        const explained = KEYS_MODAL_MODEL.bindings.some((binding) =>
          binding.name === event.name
          && binding.mode === surface.mode
          && binding.action === resolved.action
          && (binding.shift ?? false) === event.shift
          && (binding.ctrl ?? false) === event.ctrl
          && (binding.mapView === undefined || binding.mapView === surface.mapView)
        );
        const modifiers = `${event.shift ? "shift+" : ""}${event.ctrl ? "ctrl+" : ""}`;
        const label = `${surface.mode}/${surface.mapView ?? "-"} ${modifiers}${event.name}`;
        expect(`${label}:${explained}`).toBe(`${label}:true`);
      }
    }
  });

  test("unbound letters stay absent", () => {
    const tokens = entries.map((item) => item.token);
    for (const dead of ["h", "j", "k", "t", "v", ";"]) expect(tokens).not.toContain(dead);
  });

  test("KEYS actions mutate, floor, clamp through rendering, and accept wheel input", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const cache = createWrapCache();
    const backend = new ActionRuntime(state, () => undefined);
    const apply = async (action: Parameters<typeof handleOverlayAction>[0]) => {
      expect(await handleOverlayAction(action, state, source, {
        cache,
        backend,
        repaint: () => undefined,
        renderer: { height: 10 } as never,
        applyTheme: () => undefined,
        previewTheme: () => undefined
      })).toBeTrue();
    };
    state.mode = "KEYS";

    await apply({ action: "focus-previous" });
    expect(state.keysScrollTop).toBe(0);
    await apply({ action: "focus-next" });
    await apply({ action: "scroll-down" });
    await apply({ action: "scroll-up" });
    expect(state.keysScrollTop).toBe(1);

    await apply({ action: "scroll-down" });
    expect(state.keysScrollTop).toBe(3);
    await apply({ action: "scroll-up" });
    expect(state.keysScrollTop).toBe(1);

    const wheel = mouseToAction({
      type: "scroll",
      scroll: { direction: "down" },
      modifiers: { shift: false, alt: false, ctrl: false }
    } as never, state);
    expect(wheel).toEqual({ action: "focus-next" });
    if (wheel === null) throw new Error("expected wheel input to resolve");
    await apply(wheel);
    expect(state.keysScrollTop).toBe(2);

    state.keysScrollTop = 500;
    const rendered = renderStoryScreen(state, {
      width: 80,
      height: 24,
      wrapCache: cache
    });
    expect(rendered.derived.keysScrollTop).toBeLessThan(500);
    state.keysScrollTop = rendered.derived.keysScrollTop;

    await apply({ action: "cancel" });
    expect(state.mode).toBe("NAV");
    backend.dispose();
  });
});
