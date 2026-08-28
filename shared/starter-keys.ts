/**
 * The keys the starter tour teaches, declared once.
 *
 * Prose spells a key as `[token]`; tests bind every declaration to the real
 * resolver and to the in-app keys overlay, in both directions. A rebound key
 * therefore fails the suite rather than surviving as a bracketed lie, which is
 * the failure mode that matters: onboarding that confidently teaches the wrong
 * key is worse than none.
 *
 * Kept apart from the prose because the two have different lifetimes — the
 * content grows, this contract should not.
 */

export interface StarterKey {
  /** `KeyEvent.name` exactly as the TUI resolver observes it. */
  readonly name: string;
  /** How the prose spells the key, wrapped in square brackets. */
  readonly token: string;
  readonly mode: "NAV" | "MAP";
  readonly shift?: true;
  readonly ctrl?: true;
  /** Map bindings that only exist in a particular view. */
  readonly mapView?: "path" | "tree" | "mass";
}

export const STARTER_KEYS = {
  takeNext: { name: "right", token: "→", mode: "NAV" },
  takePrevious: { name: "left", token: "←", mode: "NAV" },
  focusNext: { name: "down", token: "↓", mode: "NAV" },
  focusPrevious: { name: "up", token: "↑", mode: "NAV" },
  scrollLineDown: { name: "down", token: "⇧↓", mode: "NAV", shift: true },
  scrollLineUp: { name: "up", token: "⇧↑", mode: "NAV", shift: true },
  continue: { name: "space", token: "space", mode: "NAV" },
  compose: { name: "return", token: "enter", mode: "NAV" },
  write: { name: "w", token: "w", mode: "NAV" },
  edit: { name: "e", token: "e", mode: "NAV" },
  regenerate: { name: "r", token: "r", mode: "NAV" },
  reprompt: { name: "r", token: "R", mode: "NAV", shift: true },
  undo: { name: "u", token: "u", mode: "NAV" },
  top: { name: "g", token: "g", mode: "NAV" },
  leaf: { name: "g", token: "G", mode: "NAV", shift: true },
  instructions: { name: "p", token: "p", mode: "NAV" },
  tag: { name: "t", token: "t", mode: "NAV" },
  prune: { name: "d", token: "D", mode: "NAV", shift: true },
  openMap: { name: "m", token: "m", mode: "NAV" },
  openLibrary: { name: "o", token: "o", mode: "NAV" },
  openFacts: { name: "f", token: "f", mode: "NAV" },
  openChapters: { name: "c", token: "c", mode: "NAV" },
  createChapter: { name: "c", token: "C", mode: "NAV", shift: true },
  newStory: { name: "n", token: "n", mode: "NAV" },
  actions: { name: "x", token: "x", mode: "NAV" },
  keys: { name: "?", token: "?", mode: "NAV" },
  settings: { name: ",", token: ",", mode: "NAV" },
  commands: { name: ":", token: ":", mode: "NAV" },
  quit: { name: "q", token: "q", mode: "NAV" },
  mapCycleView: { name: "m", token: "m", mode: "MAP" },
  mapClose: { name: "escape", token: "esc", mode: "MAP" },
  mapDetail: { name: "a", token: "a", mode: "MAP" },
  mapJump: { name: "return", token: "enter", mode: "MAP" },
  mapTag: { name: "t", token: "t", mode: "MAP", mapView: "path" }
} as const satisfies Record<string, StarterKey>;

export type StarterKeyId = keyof typeof STARTER_KEYS;

/** The bracketed spelling the prose must use for a declared key. */
export function starterKeyToken(id: StarterKeyId): string {
  return `[${STARTER_KEYS[id].token}]`;
}
