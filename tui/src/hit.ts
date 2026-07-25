import type { KeyAction } from "./keys.js";
import type { MapView } from "./map-state.js";
import type { SettingsRowId } from "./state.js";

/** What a screen cell points at, so a click can act on it. Rebuilt on every
 *  render — the terminal gives us coordinates, not widgets. */
export type HitTarget =
  | { kind: "part"; index: number; rowId: string }
  | {
      kind: "list";
      index: number;
      /** Paint-time selection truth for live-reordered lists. */
      selected?: boolean;
      /** A tree row's activation semantics: nodes reroute, cold rows unfold. */
      mapRow?: { id: string; kind: "node" | "sketch" | "cold" };
    }
  | { kind: "fact"; index: number }
  | { kind: "chip"; index: number }
  | { kind: "take"; row: number; take: number }
  | { kind: "map-view"; view: MapView }
  /** Exact sibling control in the focused story-part gutter. */
  | { kind: "story-take"; take: number }
  /** Shortcut from story chrome into one exact Settings row. */
  | { kind: "settings-row"; row: SettingsRowId }
  | { kind: "action"; action: KeyAction; index?: number }
  /** Row control whose non-left clicks deliberately fall through to its row. */
  | { kind: "inline-action"; action: KeyAction }
  /** A rendered part prompt; left-click toggles its inline expansion. */
  | { kind: "prompt"; index: number; rowId: string }
  | { kind: "composer" }
  /** Page behind an open panel: a click there dismisses the panel. */
  | { kind: "scrim" }
  /** Panel chrome — titles, headers, rules: visible but not actionable. */
  | { kind: "panel" };

/** A target and the columns it actually covers. */
export interface HitRegion {
  target: HitTarget;
  left: number;
  /** Exclusive. */
  right: number;
}

/** Broad row fallback plus any narrower controls drawn over it. */
export interface HitRow extends HitRegion {
  /** Narrow controls drawn over a broader row target. Last added wins. */
  overrides?: HitRegion[];
}

export type HitRows = Array<HitRow | null>;

export function hitAt(rows: HitRows, x: number, y: number, includeOverrides = true): HitTarget | null {
  const row = rows[y];
  if (row === undefined || row === null) return null;
  const override = includeOverrides
    ? row.overrides?.findLast((candidate) => x >= candidate.left && x < candidate.right)
    : undefined;
  if (override !== undefined) return override.target;
  return x >= row.left && x < row.right ? row.target : null;
}

/** Add a narrow control without losing the row's broader fallback target. */
export function addHit(rows: HitRows, y: number, hit: HitRegion): void {
  const row = rows[y];
  if (row === undefined || row === null) {
    rows[y] = hit;
    return;
  }
  rows[y] = { ...row, overrides: [...row.overrides ?? [], hit] };
}

export function fillRows(rows: HitRows, from: number, to: number, row: HitRow | null): void {
  for (let index = Math.max(0, from); index < Math.min(rows.length, to); index += 1) rows[index] = row;
}
