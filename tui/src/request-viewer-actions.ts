import type { KeyEvent } from "@opentui/core";
import type { ResolvedKey } from "./keys.js";
import type { RequestViewerState, RuntimeState } from "./state.js";

type RequestViewerReturnMode = RequestViewerState["returnMode"];

/** Open the read-only request document without moving its owner. */
export function openRequestViewer(
  state: RuntimeState,
  returnMode: RequestViewerReturnMode = state.mode === "COMPOSE" ? "COMPOSE" : "NAV"
): void {
  state.request = { cursor: 0, scrollTop: -1, returnMode };
  state.mode = "REQUEST";
}

export function closeRequestViewer(state: RuntimeState): void {
  const request = state.request;
  if (request === null) return;
  state.mode = request.returnMode;
  state.request = null;
}

export function resolveRequestViewerKey(key: KeyEvent): ResolvedKey {
  if (key.ctrl && !key.meta && !key.super && key.name.toLowerCase() === "r") {
    return { action: "open-request" };
  }
  if (key.name === "down") return { action: key.shift ? "scroll-line-down" : "focus-next" };
  if (key.name === "up") return { action: key.shift ? "scroll-line-up" : "focus-previous" };
  if (key.name === "pagedown") return { action: "scroll-down" };
  if (key.name === "pageup") return { action: "scroll-up" };
  if (!key.ctrl && !key.meta && !key.super && !key.shift && key.name === "g") {
    return { action: "top" };
  }
  const shiftedG = key.name === "G" || key.sequence === "G" || key.name === "g" && key.shift;
  return !key.ctrl && !key.meta && !key.super && shiftedG
    ? { action: "leaf" }
    : { action: "none" };
}

export function requestViewerAction(
  resolved: ResolvedKey,
  state: RuntimeState,
  height: number | undefined
): void {
  const request = state.request;
  if (request === null) return;
  if (resolved.action === "cancel" || resolved.action === "open-request") {
    closeRequestViewer(state);
    return;
  }
  if (resolved.action === "focus-next" || resolved.action === "focus-previous") {
    request.cursor = Math.max(0, request.cursor + (resolved.action === "focus-next" ? 1 : -1));
    request.scrollTop = -1;
  } else if (resolved.action === "focus-index") {
    request.cursor = Math.max(0, resolved.index ?? request.cursor);
    request.scrollTop = -1;
  } else if (resolved.action === "scroll-line-down" || resolved.action === "scroll-line-up") {
    const delta = resolved.action === "scroll-line-down" ? 1 : -1;
    request.scrollTop = Math.max(0, Math.max(0, request.scrollTop) + delta);
  } else if (resolved.action === "scroll-down" || resolved.action === "scroll-up") {
    const page = Math.max(1, (height ?? 7) - 6);
    const delta = resolved.action === "scroll-down" ? page : -page;
    request.scrollTop = Math.max(0, Math.max(0, request.scrollTop) + delta);
  } else if (resolved.action === "top") {
    request.cursor = 0;
    request.scrollTop = -1;
  } else if (resolved.action === "leaf") {
    request.cursor = Number.MAX_SAFE_INTEGER;
    request.scrollTop = -1;
  }
}
