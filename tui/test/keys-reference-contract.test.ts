import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { ActionRuntime } from "../src/action-runtime.js";
import { initialState } from "../src/app.js";
import { demoAppSource } from "../src/demo.js";
import { resolveKey } from "../src/keys.js";
import { mouseToAction } from "../src/mouse-actions.js";
import { handleOverlayAction } from "../src/overlay-actions.js";
import { REFERENCE_BINDING_LIST } from "../src/reference-bindings.js";
import { KEYS_MODAL_MODEL } from "../src/screens/keys-modal.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";

function key(
  name: string,
  options: { sequence?: string; shift?: boolean; ctrl?: boolean } = {}
): KeyEvent {
  const shift = options.shift ?? false;
  const resolvedName = shift && /^[a-z]$/.test(name) ? name.toUpperCase() : name;
  return {
    name: resolvedName,
    sequence: options.sequence ?? resolvedName,
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
          ...(binding.sequence === undefined ? {} : { sequence: binding.sequence }),
          ...(binding.shift === true ? { shift: true } : {}),
          ...(binding.ctrl === true ? { ctrl: true } : {})
        });
        const mapViews = binding.mode === "MAP" && binding.mapView === undefined
          ? (["path", "tree", "mass"] as const)
          : [binding.mapView];
        for (const mapView of mapViews) {
          expect(resolveKey(event, binding.mode, { mapView }).action).toBe(binding.action);
        }
      }
    }
  });

  test("every reference-visible route is grouped exactly once", () => {
    expect(KEYS_MODAL_MODEL.bindings.length).toBe(REFERENCE_BINDING_LIST.length);
    for (const binding of REFERENCE_BINDING_LIST) {
      expect(KEYS_MODAL_MODEL.bindings.filter((item) => item === binding)).toHaveLength(1);
    }
  });

  test("shifted-letter routes accept every terminal encoding", () => {
    const bindings = REFERENCE_BINDING_LIST.filter((binding) =>
      binding.lane === "nav-shifted" && /^[A-Z]$/.test(binding.name)
    );
    for (const binding of bindings) {
      const lower = binding.name.toLowerCase();
      const variants = [
        { name: lower, sequence: binding.name, shift: true },
        { name: binding.name, sequence: binding.name, shift: true },
        { name: binding.name, sequence: binding.name, shift: false }
      ];
      for (const variant of variants) {
        const event = {
          ...variant,
          ctrl: false,
          meta: false,
          super: false
        } as KeyEvent;
        expect(resolveKey(event, binding.mode).action).toBe(binding.action);
      }
    }
  });

  test("unbound letters stay absent", () => {
    const tokens = entries.map((item) => item.token);
    for (const dead of ["h", "j", "k", "b", "v", ";"]) expect(tokens).not.toContain(dead);
  });

  test("KEYS actions mutate, floor, clamp through rendering, and accept wheel input", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const cache = createWrapCache<ProseStyle>();
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
    expect(state.keysScrollTop).toBe(4);
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
