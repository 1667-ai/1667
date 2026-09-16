/** Adapts a browser `KeyboardEvent` to the TUI's key-resolution machinery so
 * the desktop reads the TUI keymap instead of hand-copying it. Only
 * `resolveReferenceBinding` and its types are imported; that function reads
 * a plain `KeyEvent`-shaped object (see `keyEventFromDom`), so nothing here
 * pulls `@opentui/core` runtime code into the desktop bundle. */
import {
  resolveReferenceBinding,
  type ReferenceBinding,
  type ReferenceBindingLane
} from "../tui/src/reference-bindings.js";

/** The exact shape `resolveReferenceBinding` expects, derived from its own
 * signature rather than importing `KeyEvent` from `@opentui/core` by name —
 * that class lives only in `tui/node_modules` and desktop code never needs
 * its full shape, only the handful of fields the resolver reads. */
type ReferenceKeyEvent = Parameters<typeof resolveReferenceBinding>[1];

export type DesktopKeymapMode = "NAV" | "MAP";
export type DesktopMapView = "path" | "tree" | "mass";

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

/** Builds the minimal `KeyEvent`-shaped object the resolver reads: `name`
 * (lowercase letter for letters, the TUI's own word for named keys, or the
 * literal character for punctuation such as `?`/`!`/`/`/`:`/`,`/`[`/`]`;
 * uppercase when shift decorates a letter, mirroring `shiftedLetterMatches`),
 * `sequence` (the raw `event.key`), `shift`, `ctrl`, `meta` (`metaKey`), and
 * `option` (`altKey`). Every other `KeyEvent` field (`raw`, `eventType`,
 * `source`, `number`, …) is absent — `resolveReferenceBinding` never reads
 * them, and nothing downstream of it does either.
 *
 * The uppercase/lowercase choice trusts `event.key`'s own case first, and
 * only falls back to `shiftKey` when the key arrives lowercase: a real
 * Caps Lock `G` reports `shiftKey: false`, and Electron's synthetic
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
    meta: event.metaKey,
    option: event.altKey
  } as ReferenceKeyEvent;
}

// Mirrors `resolveKey`'s own lane order in tui/src/keys.ts: global,
// nav-shifted, nav-chord, (compose-chord — desktop never reaches COMPOSE
// mode here), (map — MAP_LANES below handles that mode separately), nav
// last. `nav-shifted` must beat `nav` or a Shift+arrow (line scroll) resolves
// as the plain arrow's focus move instead, because a `nav` binding with no
// `shift` field still matches a shifted key.
const NAV_LANES: readonly ReferenceBindingLane[] = ["global", "nav-shifted", "nav-chord", "nav"];
const MAP_LANES: readonly ReferenceBindingLane[] = ["global", "map"];

/** Tries the lanes a plain (non-⌘) keypress can resolve through on the
 * desktop, in priority order, and returns the first match. `⌘` is always the
 * desktop's own layer (destinations, palette, save) — a binding never
 * resolves while it is held, even on platforms where `ctrl` doubles for it,
 * because the desktop-only chords in `renderer.ts` already own `ctrl` there. */
export function resolveDesktopBinding(
  event: KeyboardEvent,
  mode: DesktopKeymapMode,
  mapView: DesktopMapView = "path"
): ReferenceBinding | null {
  if (event.metaKey) return null;
  const key = keyEventFromDom(event);
  const lanes = mode === "MAP" ? MAP_LANES : NAV_LANES;
  for (const lane of lanes) {
    const binding = resolveReferenceBinding(lane, key, mode, mapView);
    if (binding !== null) return binding;
  }
  return null;
}

/** True when the keyboard is owned by a text field, so a plain letter must
 * type instead of running a command: an `input`/`textarea`/`select`, a
 * `contenteditable` element, or anything inside a dialog (`.modal-card`).
 * Buttons and links are not fields — letters still act when one has focus. */
export function fieldHasFocus(): boolean {
  const active = document.activeElement;
  if (active === null) return false;
  if (active instanceof HTMLInputElement
    || active instanceof HTMLTextAreaElement
    || active instanceof HTMLSelectElement) return true;
  return active.matches("[contenteditable]") || active.closest(".modal-card") !== null;
}

/** True when the focused element already gives `Enter`/`Space` a browser
 * meaning of its own: activating it (a Library story row, a rail icon, a
 * palette row). `preventDefault()` on the keydown that the TUI keymap would
 * otherwise send for `compose`/`continue` also cancels that native click, so
 * the keymap must not resolve either key while a button or link has focus. */
export function activatesOnEnterOrSpace(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLElement
    && (active instanceof HTMLButtonElement || active instanceof HTMLAnchorElement || active.getAttribute("role") === "button");
}
