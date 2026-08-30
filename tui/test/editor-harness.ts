import type { KeyEvent } from "@opentui/core";
import { handleKey, initialState } from "../src/app.js";
import { demoAppSource } from "../src/demo.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";

export function key(
  name: string,
  options: { sequence?: string; ctrl?: boolean; shift?: boolean; meta?: boolean } = {}
): KeyEvent {
  return {
    name,
    sequence: options.sequence ?? name,
    shift: options.shift ?? false,
    ctrl: options.ctrl ?? false,
    meta: options.meta ?? false
  } as KeyEvent;
}

export function editorHarness(rendererWidth?: number) {
  const source = demoAppSource();
  const state = initialState(source, false);
  // Existing editor interaction tests exercise the complete field set. The
  // product default remains Simple; focused Simple-mode coverage sets the
  // preference explicitly.
  state.config = { ...state.config, factsViewMode: "advanced" };
  source.config = state.config;
  const cache = createWrapCache<ProseStyle>();
  const press = (event: KeyEvent) => handleKey(
    event,
    state,
    source,
    cache,
    () => undefined,
    async () => undefined,
    () => undefined,
    rendererWidth === undefined
      ? null
      : {
          width: rendererWidth,
          height: 24,
          clearSelection: () => undefined
        } as never
  );
  return { source, state, cache, press };
}
