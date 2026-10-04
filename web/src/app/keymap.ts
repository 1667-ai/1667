import { useEffect, type RefObject } from "react";
import type { ReferenceBinding } from "../../../shared/reference-bindings.js";
import { fieldHasFocus, resolveManuscriptBinding, resolveOverlayBinding } from "./keymap-dom.js";
import type { OverlayKind } from "./state.js";

/**
 * The app's keybindings beyond native browser behavior. `/` (focus search)
 * stays first and always wins, checked before any screen's own keys ever
 * get a look (owner decision — `open-search` is not itself in the TUI table
 * this reads from `app/keymap-dom.ts`'s step-6 addition on).
 *
 * A screen registers its own key handler with `registerScreenKeys` while it
 * is mounted (`story/StoryView.tsx`) instead of
 * wiring its own `keydown` listener — one listener here resolves the key
 * through the TUI's own table (`shared/reference-bindings.ts`) and hands the
 * screen only the resolved `ReferenceBinding`, so a screen never touches a
 * raw `KeyboardEvent`'s key-naming quirks itself. `preventDefault` runs only
 * when the handler reports it actually did something with the key — every
 * other later-step key (the map, facts, and so on) resolves to nothing and
 * keeps its native browser behavior, exactly as an unhandled key would.
 *
 * Escape is a second, independent sibling of the `/` branch, not a
 * `ReferenceBinding` dispatched through a screen (review fix #3): it stops a
 * running/settling generation from anywhere — any route, any screen, even
 * the library — as long as nothing else has already claimed the key.
 * `event.defaultPrevented` is that claim check: `ui/usePopover.ts`'s own
 * Escape-close now calls `preventDefault`, and its `document`-level listener
 * always runs before this `window`-level one in the bubble phase, so closing
 * a menu never also stops a background generation on the same keypress.
 * `stopGeneration` returns `false` when there was nothing to stop, so this
 * only claims the key (and calls `preventDefault` itself) when it actually
 * did something with it.
 */
export interface Keymap {
  readonly searchRef: RefObject<HTMLInputElement | null>;
  readonly stopGeneration: () => boolean;
  /** `:` palette, `?` keys help, `!` notice log. */
  readonly openOverlay: (kind: OverlayKind) => void;
}

const OVERLAY_OF_ACTION: Readonly<Record<string, OverlayKind>> = {
  "open-commands": "palette",
  "open-keys": "keys",
  "open-log": "log"
};

/** Returns `true` when it handled the binding (and so `preventDefault` should
 * run) — a `ReferenceBinding` whose action this screen does not implement
 * returns `false`, the same as no binding having resolved at all. */
export type ScreenKeyHandler = (binding: ReferenceBinding, event: KeyboardEvent) => boolean;

/** One layer of key handling: how it reads a key, and what it does with the
 * result. The top layer wins; the layers below it hear nothing. A layer that
 * `claimsEscape` also gets Escape before the generation-stop branch (the
 * story map closes on Esc even while a generation runs). */
export interface KeyLayer {
  readonly resolve: (event: KeyboardEvent) => ReferenceBinding | null;
  readonly handle: ScreenKeyHandler;
  readonly claimsEscape?: boolean;
}

/** The base layer: the one active screen's handler, reading the NAV keys. */
let baseLayer: KeyLayer | null = null;
const stack: KeyLayer[] = [];

function topLayer(): KeyLayer | null {
  return stack.at(-1) ?? baseLayer;
}

/** Registers the one active screen's key handler as the base layer; returns
 * the disposer that unregisters it. A later call replaces an earlier one
 * outright, and unregistering a handler that has already been replaced is a
 * no-op, so an effect's cleanup running after a route change never clobbers
 * whatever the new screen just registered. */
export function registerScreenKeys(handler: ScreenKeyHandler): () => void {
  const layer: KeyLayer = { resolve: resolveManuscriptBinding, handle: handler };
  baseLayer = layer;
  return () => {
    if (baseLayer === layer) baseLayer = null;
  };
}

/** Pushes a layer above the screen's keys; returns the disposer, which
 * removes exactly this layer (by identity) wherever it sits in the stack. */
export function pushKeyLayer(layer: KeyLayer): () => void {
  const own = { ...layer };
  stack.push(own);
  return () => {
    const at = stack.indexOf(own);
    if (at >= 0) stack.splice(at, 1);
  };
}

export function useKeymap(keymap: Keymap): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // A key something already handled is nobody else's. This is
      // load-bearing for two hand-backs: the composer's Enter and an editor's
      // close both move keyboard focus off the field in their own handler,
      // which runs before this listener — so by the time it runs, no field
      // has focus any more, and without this check the same key would be
      // read again as a screen key (Enter would reopen the composer it just
      // left). `usePopover`'s Escape and every field's Escape rely on it too:
      // they call `preventDefault` so a close never also stops a generation.
      if (event.defaultPrevented) return;
      if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey && !fieldHasFocus()) {
        event.preventDefault();
        keymap.searchRef.current?.focus();
        return;
      }
      if (!fieldHasFocus()) {
        const overlay = OVERLAY_OF_ACTION[resolveOverlayBinding(event)?.action ?? ""];
        if (overlay !== undefined) {
          event.preventDefault();
          keymap.openOverlay(overlay);
          return;
        }
      }
      const layer = topLayer();
      if (event.key === "Escape" && layer?.claimsEscape !== true && !fieldHasFocus() && keymap.stopGeneration()) {
        event.preventDefault();
        return;
      }
      if (layer === null || fieldHasFocus()) return;
      const binding = layer.resolve(event);
      if (binding === null) return;
      if (layer.handle(binding, event)) event.preventDefault();
    };
    addEventListener("keydown", onKeyDown);
    return () => removeEventListener("keydown", onKeyDown);
  }, [keymap.searchRef, keymap.stopGeneration, keymap.openOverlay]);
}
