import type { KeyEvent } from "@opentui/core";
import type { AppMode, KeyAction } from "./keys.js";
import type { MapView } from "./map-state.js";

export interface ReferenceBinding {
  display: string;
  lane: ReferenceBindingLane;
  name: string;
  mode: AppMode;
  action: KeyAction;
  sequence?: string;
  shift?: boolean;
  ctrl?: boolean;
  mapView?: MapView;
}

export type ReferenceBindingLane =
  | "global"
  | "nav-shifted"
  | "nav-chord"
  | "compose-chord"
  | "map"
  | "search"
  | "nav";

type BindingOptions = Partial<Pick<
  ReferenceBinding,
  "sequence" | "shift" | "ctrl" | "mapView"
>>;

type BindingDefinition = Omit<ReferenceBinding, "display">;

function route(
  lane: ReferenceBindingLane,
  name: string,
  mode: AppMode,
  action: KeyAction,
  extra: BindingOptions = {}
): BindingDefinition {
  return { lane, name, mode, action, ...extra };
}

/** Reference-visible routes. `resolveKey` consumes these same objects, so
 *  adding an ordinary NAV/MAP gesture requires adding it here before the
 *  explanatory screen can group it. Context overrides such as offline retry
 *  and armed prune confirmation remain in `resolveKey`. */
const DEFINITIONS = {
  navFocusPrevious: route("nav", "up", "NAV", "focus-previous"),
  navFocusNext: route("nav", "down", "NAV", "focus-next"),
  mapFocusPrevious: route("map", "up", "MAP", "focus-previous"),
  mapFocusNext: route("map", "down", "MAP", "focus-next"),
  navTakePrevious: route("nav", "left", "NAV", "take-previous"),
  navTakeNext: route("nav", "right", "NAV", "take-next"),
  mapPathTakePrevious: route("map", "left", "MAP", "take-previous", { mapView: "path" }),
  mapPathTakeNext: route("map", "right", "MAP", "take-next", { mapView: "path" }),
  mapTreeLanePrevious: route("map", "left", "MAP", "take-previous", { mapView: "tree" }),
  mapTreeLaneNext: route("map", "right", "MAP", "take-next", { mapView: "tree" }),
  mapTreePath: route("map", "tab", "MAP", "map-hide-lanes", { mapView: "tree" }),
  navScrollLineUp: route("nav-shifted", "up", "NAV", "scroll-line-up", { shift: true }),
  navScrollLineDown: route("nav-shifted", "down", "NAV", "scroll-line-down", { shift: true }),
  navPageUp: route("nav", "pageup", "NAV", "scroll-up"),
  navCtrlPageUp: route("nav-chord", "u", "NAV", "scroll-up", { ctrl: true }),
  navPageDown: route("nav", "pagedown", "NAV", "scroll-down"),
  navCtrlPageDown: route("nav-chord", "d", "NAV", "scroll-down", { ctrl: true }),
  navTop: route("nav", "g", "NAV", "top"),
  navLeaf: route("nav-shifted", "G", "NAV", "leaf", { shift: true }),
  navChapterPrevious: route("nav", "[", "NAV", "chapter-previous"),
  navChapterNext: route("nav", "]", "NAV", "chapter-next"),
  navUndo: route("nav", "u", "NAV", "undo"),
  navContinue: route("nav", "space", "NAV", "continue"),
  navComposeEnter: route("nav", "return", "NAV", "compose"),
  navComposeI: route("nav", "i", "NAV", "compose"),
  navRegenerate: route("nav", "r", "NAV", "regenerate"),
  navRetakeWithPrompt: route("nav-shifted", "R", "NAV", "retake-with-prompt", { shift: true }),
  navWrite: route("nav", "w", "NAV", "write"),
  navEdit: route("nav", "e", "NAV", "edit"),
  navAside: route("nav", "a", "NAV", "open-aside"),
  navAuthorsNote: route("nav", "n", "NAV", "open-authors-note"),
  navCopyPart: route("nav", "y", "NAV", "copy-part"),
  navCopyLine: route("nav-shifted", "Y", "NAV", "copy-line", { shift: true }),
  composeHistoryPrevious: route("compose-chord", "up", "COMPOSE", "history-previous", { ctrl: true }),
  composeHistoryNext: route("compose-chord", "down", "COMPOSE", "history-next", { ctrl: true }),
  navPrune: route("nav-shifted", "D", "NAV", "prune", { shift: true }),
  navTag: route("nav", "t", "NAV", "tag"),
  navOpenChapters: route("nav", "c", "NAV", "open-chapters"),
  navCreateChapter: route("nav-shifted", "C", "NAV", "create-chapter", { shift: true }),
  navOpenActions: route("nav", "x", "NAV", "open-actions"),
  navToggleInstructions: route("nav", "p", "NAV", "toggle-instructions"),
  // `T` (shift), not `r`: `r` already means retake (regenerate) on a story
  // part, and overloading it would silently drop retake from exactly the
  // parts that have a thought to fold.
  navToggleThought: route("nav-shifted", "T", "NAV", "toggle-thought", { shift: true }),
  navTypewriter: route("nav", "z", "NAV", "typewriter"),
  navToggleRail: route("nav-shifted", "F", "NAV", "toggle-rail", { shift: true }),
  navOpenMap: route("nav", "m", "NAV", "open-map"),
  navOpenFacts: route("nav", "f", "NAV", "open-facts"),
  navOpenLibrary: route("nav", "o", "NAV", "open-library"),
  navOpenCommandsColon: route("nav", ":", "NAV", "open-commands"),
  navOpenCommandsCtrlP: route("nav-chord", "p", "NAV", "open-commands", { ctrl: true }),
  navOpenSettings: route("nav", ",", "NAV", "open-settings"),
  navToggleContext: route("nav-chord", "g", "NAV", "toggle-context-meter", { ctrl: true }),
  composeToggleContext: route("compose-chord", "g", "COMPOSE", "toggle-context-meter", { ctrl: true }),
  navOpenRequest: route("nav-chord", "r", "NAV", "open-request", { ctrl: true }),
  composeOpenRequest: route("compose-chord", "r", "COMPOSE", "open-request", { ctrl: true }),
  // "l" for "logprobs" — the header the viewer itself shows.
  navOpenProbs: route("nav", "l", "NAV", "open-probs"),
  // "h" opens the Generation Record Viewer on the focused take without
  // moving NAV's or MAP's own focus — every MAP view, including tree/mass.
  navOpenRecords: route("nav", "h", "NAV", "open-records"),
  mapOpenRecords: route("map", "h", "MAP", "open-records"),
  navOpenSearch: route("nav", "/", "NAV", "open-search", { sequence: "/" }),
  navOpenKeysQuestion: route("nav", "?", "NAV", "open-keys"),
  // Decision 24 gives global feedback a letter key of its own, unbound
  // everywhere else. Terminals disagree on whether `!` arrives as its own
  // name or as shifted `1`, so both spellings route here.
  navOpenLog: route("nav", "!", "NAV", "open-log", { sequence: "!" }),
  navOpenLogShifted: route("nav", "1", "NAV", "open-log", {
    sequence: "!",
    shift: true
  }),
  mapOpenLog: route("map", "!", "MAP", "open-log", { sequence: "!" }),
  mapOpenLogShifted: route("map", "1", "MAP", "open-log", {
    sequence: "!",
    shift: true
  }),
  navOpenKeysShiftSlash: route("nav", "/", "NAV", "open-keys", {
    sequence: "?",
    shift: true
  }),
  navClose: route("global", "escape", "NAV", "cancel"),
  mapClose: route("global", "escape", "MAP", "cancel"),
  keysClose: route("global", "escape", "KEYS", "cancel"),
  logClose: route("global", "escape", "LOG", "cancel"),
  navQuit: route("nav", "q", "NAV", "quit"),
  mapCycleView: route("map", "m", "MAP", "cycle-map-view"),
  // `f` is contextual to the tree map: NAV keeps its existing `f` Facts
  // opener, while the tree uses this otherwise-free key to lens one Fact.
  mapOpenFactLens: route("map", "f", "MAP", "open-fact-lens", { mapView: "tree" }),
  mapPathAllTakes: route("map", "a", "MAP", "toggle-path-takes", { mapView: "path" }),
  mapTreeSketches: route("map", "a", "MAP", "toggle-sketches", { mapView: "tree" }),
  mapMassSketches: route("map", "a", "MAP", "toggle-sketches", { mapView: "mass" }),
  mapApply: route("map", "return", "MAP", "apply"),
  mapTreeFollow: route("map", "l", "MAP", "map-follow", { mapView: "tree" }),
  mapMassFollow: route("map", "l", "MAP", "map-follow", { mapView: "mass" }),
  // Only mass sorts. The tree is the graph order itself, so there is nothing
  // for `s` to reorder there; it used to teleport to mass under a `s sort`
  // label, which advertised a verb the view does not have (C-06).
  mapMassSort: route("map", "s", "MAP", "map-cycle-sort", { mapView: "mass" }),
  mapPathPrune: route("map", "D", "MAP", "prune", { mapView: "path", shift: true }),
  mapPathTag: route("map", "t", "MAP", "tag", { mapView: "path" }),
  searchClose: route("global", "escape", "SEARCH", "cancel"),
  cardClose: route("global", "escape", "CARD", "cancel"),
  searchFocusPrevious: route("search", "up", "SEARCH", "focus-previous"),
  searchFocusNext: route("search", "down", "SEARCH", "focus-next"),
  searchFold: route("search", "left", "SEARCH", "take-previous"),
  searchUnfold: route("search", "right", "SEARCH", "take-next"),
  searchScope: route("search", "tab", "SEARCH", "cycle"),
  searchOpen: route("search", "return", "SEARCH", "apply"),
  // The query field is always live, so the case switch has to be a chord: a
  // bare `c` belongs to the writer's query, not to the chrome.
  searchCase: route("search", "s", "SEARCH", "toggle-search-case", { ctrl: true })
} as const satisfies Record<string, BindingDefinition>;

export type ReferenceBindingId = keyof typeof DEFINITIONS;

function bindingDisplay(binding: BindingDefinition): string {
  const base = binding.sequence ?? ({
    up: "↑",
    down: "↓",
    left: "←",
    right: "→",
    pageup: "pgup",
    pagedown: "pgdn",
    return: "enter",
    escape: "esc"
  }[binding.name] ?? binding.name);
  if (binding.ctrl === true) return `⌃${base}`;
  if (binding.shift === true && ["up", "down", "left", "right"].includes(binding.name)) {
    return `⇧${base}`;
  }
  return base;
}

export const REFERENCE_BINDINGS = Object.freeze(Object.fromEntries(
  Object.entries(DEFINITIONS).map(([id, binding]) => [
    id,
    Object.freeze({ ...binding, display: bindingDisplay(binding) })
  ])
)) as Readonly<Record<ReferenceBindingId, ReferenceBinding>>;

export const REFERENCE_BINDING_LIST: readonly ReferenceBinding[] =
  Object.freeze(Object.values(REFERENCE_BINDINGS));

function shiftedLetterMatches(key: KeyEvent, upper: string): boolean {
  const lower = upper.toLowerCase();
  return key.name === upper
    || key.sequence === upper
    || (key.name === lower && key.shift);
}

function matches(
  binding: ReferenceBinding,
  key: KeyEvent,
  mode: AppMode,
  mapView: MapView
): boolean {
  if (binding.mode !== mode || key.meta) return false;
  if ((binding.ctrl ?? false) !== Boolean(key.ctrl)) return false;
  if (binding.mapView !== undefined && binding.mapView !== mapView) return false;
  if (binding.sequence !== undefined && binding.sequence !== key.sequence) return false;
  if (binding.shift === true && /^[A-Z]$/.test(binding.name)) {
    return shiftedLetterMatches(key, binding.name);
  }
  const nameMatches = binding.lane === "compose-chord"
    ? binding.name.toLowerCase() === key.name.toLowerCase()
    : binding.name === key.name;
  return nameMatches
    && (binding.shift !== true || key.shift);
}

export function resolveReferenceBinding(
  lane: ReferenceBindingLane,
  key: KeyEvent,
  mode: AppMode,
  mapView: MapView
): ReferenceBinding | null {
  return REFERENCE_BINDING_LIST.find((binding) =>
    binding.lane === lane && matches(binding, key, mode, mapView)
  ) ?? null;
}
