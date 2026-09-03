import type { SettingsRoutePurpose } from "../../shared/settings-v2-types.js";
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
      /** Stable identity for rows whose live projection can change order. */
      rowId?: string;
      /** Paint-time selection truth for live-reordered lists. */
      selected?: boolean;
      /** A tree row's activation semantics: nodes reroute, cold rows unfold. */
      mapRow?: { id: string; kind: "node" | "sketch" | "cold" };
    }
  | { kind: "fact"; index: number }
  | { kind: "chip"; index: number; group?: "tag" | "scope" }
  | { kind: "take"; row: number; take: number }
  | { kind: "map-view"; view: MapView }
  /** Exact sibling control in the focused story-part surface. */
  | { kind: "story-take"; take: number; rowId?: string }
  /** Shortcut from story chrome into one exact Settings row. */
  | { kind: "settings-row"; row: SettingsRowId; profilePurpose?: SettingsRoutePurpose }
  | {
      kind: "action";
      action: KeyAction;
      index?: number;
      rowId?: string;
      /** Exact editor field for a choice arrow. */
      composerSourceId?: string;
    }
  /** Row control whose non-left clicks deliberately fall through to its row. */
  | {
      kind: "inline-action";
      action: KeyAction;
      /** Stable identity for a painted control (for example Placement stop). */
      rowId?: string;
    }
  /** A rendered part prompt; left-click toggles its inline expansion. */
  | { kind: "prompt"; index: number; rowId: string }
  /** A part's thought waymark or unfolded block; left-click toggles its fold
   *  state, same as pressing `T` with that part focused. */
  | { kind: "thought"; index: number; rowId: string }
  | {
      kind: "composer";
      /** Exact field identity for multi-buffer editors. */
      composerSourceId?: string;
      composerEditable?: boolean;
      /** Absolute grapheme offset selected by a click in the field. */
      composerCursor?: number;
    }
  /** Page behind an open panel: a click there dismisses the panel. */
  /** A saved Aside answer row. Right-click uses the terminal selection when
   * one exists, while the row identity supplies the answer's Placement
   * anchor. */
  | { kind: "aside-answer"; noteIndex: number; rowId: string }
  /** One exact hop-strip anchor in Aside v2. */
  | { kind: "aside-hop"; index: number; rowId: string }
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
