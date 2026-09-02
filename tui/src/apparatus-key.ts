import type { KeyEvent } from "@opentui/core";
import {
  deriveApparatusSeam,
  resolveApparatusLabel,
  visibleApparatusDoorways
} from "./apparatus-model.js";
import { isPlainNavigation, type ResolvedKey } from "./keys.js";
import { createStoryViewModel } from "./model.js";
import type { RuntimeState } from "./state.js";
import { deriveStoryFrameLayout } from "./story-frame-layout.js";

/** Resolve the one-shot apparatus chord before ordinary NAV bindings. */
export function resolveApparatusKey(
  key: KeyEvent,
  state: RuntimeState,
  terminalWidth = 80
): ResolvedKey | null {
  if (state.config.apparatus !== "on" || !isPlainNavigation(state)) {
    state.apparatusArmedNodeId = null;
    return null;
  }
  const armedNodeId = state.apparatusArmedNodeId ?? null;
  if (armedNodeId === null && !plainSiteOne(key)) return null;

  const view = createStoryViewModel(state.payload, state.stream);
  const focused = view.rows[state.focusIndex];
  const part = focused?.kind === "part" ? focused : null;
  if (armedNodeId === null) {
    if (part === null) return null;
    const seam = deriveApparatusSeam(state.payload, part);
    return seam.kind === "not-yet" && seam.doorways.length > 0
      ? { action: "arm-apparatus", rowId: part.id }
      : null;
  }

  state.apparatusArmedNodeId = null;
  // A stale arm does not consume a key for a different focused node.
  if (part === null || part.id !== armedNodeId) return null;
  if (!plainLowercaseLetter(key)) return { action: "none" };

  const seam = deriveApparatusSeam(state.payload, part);
  const pageWidth = deriveStoryFrameLayout(terminalWidth, state.config).pageWidth;
  const visible = visibleApparatusDoorways(seam, pageWidth < 100);
  const doorway = resolveApparatusLabel(visible, key.name);
  return doorway === null
    ? { action: "none" }
    : { action: "take-at", take: doorway.takeIndex, rowId: part.id };
}

function plainSiteOne(key: KeyEvent): boolean {
  return unmodified(key) && !key.shift && key.name === "1";
}

function plainLowercaseLetter(key: KeyEvent): boolean {
  return unmodified(key)
    && !key.shift
    && !/^[A-Z]$/u.test(key.sequence)
    && /^[a-z]$/u.test(key.name);
}

function unmodified(key: KeyEvent): boolean {
  return !key.ctrl && !key.meta && !key.option && !key.super;
}
