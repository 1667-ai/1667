import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { INERT_UPDATE_CHECK_LIFECYCLE } from "../src/action-context.js";
import { ActionRuntime } from "../src/action-runtime.js";
import { handleKey, initialState } from "../src/app.js";
import {
  composerSelection,
  createComposer,
  moveComposerTo
} from "../src/composer-model.js";
import { demoAppSource } from "../src/demo.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";

function key(
  name: string,
  options: { ctrl?: boolean; shift?: boolean } = {}
): KeyEvent {
  return {
    name,
    sequence: name,
    ctrl: options.ctrl ?? false,
    shift: options.shift ?? false,
    meta: false
  } as KeyEvent;
}

function harness() {
  const source = demoAppSource();
  const state = initialState(source, false);
  const backend = new ActionRuntime(state, () => undefined);
  const cache = createWrapCache<ProseStyle>();
  const press = (event: KeyEvent) => handleKey(
    event,
    state,
    source,
    cache,
    () => undefined,
    async () => undefined,
    () => undefined,
    {
      updateChecks: INERT_UPDATE_CHECK_LIFECYCLE,
      renderer: null,
      applyTheme: () => undefined,
      previewTheme: () => undefined,
      backend
    }
  );
  state.mode = "COMPOSE";
  return { state, press };
}

describe("direct composer motion", () => {
  test("line and buffer keys move and extend selection in a multiline draft", async () => {
    const { state, press } = harness();
    const text = "first\nsecond line\nthird";
    const origin = 10;
    const cases = [
      { name: "home", ctrl: false, cursor: 6 },
      { name: "end", ctrl: false, cursor: 17 },
      { name: "home", ctrl: true, cursor: 0 },
      { name: "end", ctrl: true, cursor: text.length }
    ] as const;

    for (const motion of cases) {
      state.composer = createComposer(text);
      moveComposerTo(state.composer, origin);
      await press(key(motion.name, { ctrl: motion.ctrl }));
      expect(state.composer.cursor).toBe(motion.cursor);
      expect(composerSelection(state.composer)).toBe(null);

      state.composer = createComposer(text);
      moveComposerTo(state.composer, origin);
      await press(key(motion.name, { ctrl: motion.ctrl, shift: true }));
      expect(state.composer.cursor).toBe(motion.cursor);
      expect(state.composer.anchor).toBe(origin);
      expect(composerSelection(state.composer)).toEqual({
        start: Math.min(origin, motion.cursor),
        end: Math.max(origin, motion.cursor)
      });
    }
  });

  test("vertical keys still move through history when the draft is empty", async () => {
    const { state, press } = harness();
    state.history = ["older direction", "newer direction"];
    state.historyIndex = state.history.length;
    state.composer = createComposer("");

    await press(key("up"));

    expect(state.historyIndex).toBe(1);
    expect(state.composer.text).toBe("newer direction");

    state.composer = createComposer("");
    state.historyIndex = 1;
    await press(key("down"));

    expect(state.historyIndex).toBe(2);
    expect(state.composer.text).toBe("");
  });
});
