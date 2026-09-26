/**
 * Adapts a browser `KeyboardEvent` to the TUI's key-resolution machinery
 * (`shared/reference-bindings.ts`) so the web manuscript reads the same key
 * table the TUI and the desktop app already did — ported from
 * `git show 67856fe7:desktop/renderer-keymap.ts`'s `keyEventFromDom`/
 * `fieldHasFocus`/`activatesOnEnterOrSpace` (the desktop app itself is gone;
 * this is its one surviving idea). Only `resolveReferenceBinding` and its
 * types are imported, so nothing here pulls TUI runtime code (`@opentui/core`)
 * into the web bundle.
 */
import {
  resolveReferenceBinding,
  type ReferenceBinding,
  type ReferenceBindingLane,
  type ReferenceKeyEvent
} from "../../../shared/reference-bindings.js";

const NAMED_KEY_NAMES: Readonly<Record<string, string>> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  PageUp: "pageup",
  PageDown: "pagedown",
  Enter: "return",
  Escape: "escape",
  " ": "space",
  Tab: "tab"
};

/** Builds the minimal `ReferenceKeyEvent` the resolver reads: `name`
 * (lowercase letter for letters, the TUI's own word for named keys, or the
 * literal character for punctuation such as `?`/`!`/`/`/`:`/`,`/`[`/`]`;
 * uppercase when shift decorates a letter, mirroring `shiftedLetterMatches`),
 * `sequence` (the raw `event.key`), `shift`, `ctrl`, `meta` (`metaKey`).
 *
 * The uppercase/lowercase choice trusts `event.key`'s own case first, and
 * only falls back to `shiftKey` when the key arrives lowercase: a real Caps
 * Lock `G` reports `shiftKey: false`, and Playwright's synthetic
 * `press("G")` (used by the e2e tests) reports the same — both must still
 * read as capital `G`, exactly as `shiftedLetterMatches` already tolerates
 * multiple terminal encodings of a shifted letter. */
export function keyEventFromDom(event: KeyboardEvent): ReferenceKeyEvent {
  const key = event.key;
  const named = NAMED_KEY_NAMES[key];
  const isLetter = /^[a-zA-Z]$/.test(key);
  const isUpper = isLetter && (event.shiftKey || key === key.toUpperCase());
  const name = named ?? (isLetter ? (isUpper ? key.toUpperCase() : key.toLowerCase()) : key);
  return {
    name,
    sequence: key,
    shift: event.shiftKey,
    ctrl: event.ctrlKey,
    meta: event.metaKey
  };
}

// Mirrors `resolveKey`'s own lane order in tui/src/keys.ts: global,
// nav-shifted, nav-chord, nav. `nav-shifted` must beat `nav` or a
// Shift+arrow (line scroll) resolves as the plain arrow's focus move
// instead, because a `nav` binding with no `shift` field still matches a
// shifted key. (Ported from `desktop/renderer-keymap.ts@67856fe7`'s
// `NAV_LANES`; the web manuscript has no MAP mode, so that lane list has no
// equivalent here.)
const NAV_LANES: readonly ReferenceBindingLane[] = ["global", "nav-shifted", "nav-chord", "nav"];

/** Owner decision: ⌃U, ⌃D, ⌃P stay the browser's (page-up-in-history,
 * bookmark, print) — never bound here. The shared table's own `nav-chord`
 * entries for ⌃U/⌃D resolve to the very same `scroll-up`/`scroll-down`
 * actions plain PageUp/PageDown do, and its `global` entry for ⌃P resolves
 * to `open-commands`; excluding the chord here (rather than trusting that
 * `app/keymap.ts` merely doesn't implement every action) keeps the
 * exclusion explicit even if a later step adds a command palette. */
function isBrowserReservedChord(event: KeyboardEvent): boolean {
  if (!event.ctrlKey) return false;
  const key = event.key.toLowerCase();
  return key === "u" || key === "d" || key === "p";
}

/** Tries the lanes a plain (no ⌘, no ⌥) keypress can resolve through, in
 * priority order, and returns the first match — `null` when nothing in the
 * table names this key, which `app/keymap.ts` treats as "resolves to
 * nothing, keep native browser behavior" (later-step keys, e.g. `m` for the
 * map). Alt is rejected up front for the same reason ⌘ is: Alt+←/→ is the
 * browser's own back/forward, and the reference table's plain `left`/`right`
 * bindings (take prev/next) carry no `alt` field of their own to tell the
 * two apart, so without this check they would resolve — and, since the
 * screen handler implements `take-previous`/`take-next`, get
 * `preventDefault`ed — hijacking browser navigation. */
export function resolveManuscriptBinding(event: KeyboardEvent): ReferenceBinding | null {
  if (event.metaKey || event.altKey || isBrowserReservedChord(event)) return null;
  const key = keyEventFromDom(event);
  for (const lane of NAV_LANES) {
    const binding = resolveReferenceBinding(lane, key, "NAV");
    if (binding !== null) return binding;
  }
  return null;
}

/** True when the keyboard is owned by a field, so a plain letter must type
 * instead of running a command: an `input`/`textarea`/`select`, a
 * `contenteditable` element, an open `<dialog>`, or anything inside an
 * element that opts out with `[data-owns-keys]` (the desktop version used
 * `.modal-card`, a class this app doesn't have — dialogs here are native
 * `<dialog>` elements, `web/src/ui/Modal.tsx`). Buttons and links are not
 * fields — a take-switch button still responds to ←/→ while it has focus. */
export function fieldHasFocus(): boolean {
  const active = document.activeElement;
  if (active === null) return false;
  if (active instanceof HTMLInputElement
    || active instanceof HTMLTextAreaElement
    || active instanceof HTMLSelectElement) return true;
  if (active.matches("[contenteditable]")) return true;
  if (active.closest("dialog[open]") !== null) return true;
  if (active.closest('[role="dialog"]') !== null) return true;
  return active.closest("[data-owns-keys]") !== null;
}

/** True when the focused element already gives `Enter`/`Space` a browser
 * meaning of its own: activating it, or (for `<summary>`) toggling its
 * `<details>`. The manuscript keymap must not resolve either key while one
 * of these has focus, the same rule the desktop version applied. */
export function activatesOnEnterOrSpace(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLElement
    && (active instanceof HTMLButtonElement || active instanceof HTMLAnchorElement
      || active.tagName === "SUMMARY" || active.getAttribute("role") === "button");
}
