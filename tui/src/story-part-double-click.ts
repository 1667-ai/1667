import { hitAt } from "./hit.js";
import type { ResolvedKey } from "./keys.js";
import { createStoryViewModel } from "./model.js";
import type { MouseActionState, MouseGesture } from "./mouse-actions.js";

export interface StoryPartDoubleClickGate {
  resolve(
    event: MouseGesture,
    resolved: ResolvedKey | null,
    state: MouseActionState
  ): ResolvedKey | null;
  reset(): void;
}

/** A complete double-click on a take body opens its manual editor. Detection
 *  happens on release, after the selection-safe gate proves neither click was
 *  a drag. */
export function createStoryPartDoubleClickGate(
  now: () => number = Date.now,
  thresholdMs = 500
): StoryPartDoubleClickGate {
  let previous: {
    id: string;
    at: number;
    x: number;
    y: number;
    completing: boolean;
  } | null = null;
  return {
    resolve(event, resolved, state) {
      if (event.modifiers.shift || event.type === "drag" || event.type === "scroll") {
        previous = null;
        return resolved;
      }
      const at = now();
      const pending = previous;
      const sameCell = pending !== null
        && event.button === 0
        && state.mode === "NAV"
        && event.x === pending.x
        && event.y === pending.y
        && at - pending.at <= thresholdMs;
      if (event.type === "down" && sameCell && pending !== null) {
        pending.completing = true;
        return null;
      }
      if (event.type === "up" && sameCell && pending?.completing === true) {
        const id = pending.id;
        previous = null;
        const index = createStoryViewModel(state.payload, state.stream).rows.findIndex(
          (row) => row.kind === "part" && row.id === id
        );
        return index < 0 ? resolved : { action: "edit", index, rowId: id };
      }
      const target = event.button === 0 && state.mode === "NAV"
        ? hitAt(state.hitRows, event.x, event.y)
        : null;
      if (target?.kind !== "part") {
        if (event.type === "down" || event.type === "up") previous = null;
        return resolved;
      }
      const row = createStoryViewModel(state.payload, state.stream).rows[target.index];
      if (row?.kind !== "part" || row.id !== target.rowId) {
        previous = null;
        return resolved;
      }
      if (event.type === "down") {
        if (previous?.id !== target.rowId) previous = null;
        return resolved;
      }
      if (event.type !== "up"
        || resolved?.action !== "focus-index"
        || resolved.rowId !== target.rowId) {
        return resolved;
      }
      if (previous?.id === target.rowId && at - previous.at <= thresholdMs) {
        previous = null;
        return { action: "edit", index: target.index, rowId: target.rowId };
      }
      previous = { id: target.rowId, at, x: event.x, y: event.y, completing: false };
      return resolved;
    },
    reset() {
      previous = null;
    }
  };
}
