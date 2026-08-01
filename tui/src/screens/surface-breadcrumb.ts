import {
  fitLine,
  lineWidth,
  segment,
  truncate,
  visibleWidth,
  type DisplayRole,
  type FrameLine
} from "./story/frame.js";

/** C-02's breadcrumb, for every full-bleed surface: mode cell, what the
 *  surface is showing, the story you are still inside, the line's own name,
 *  and where in it you are — then the keyline in the right slot.
 *
 *  It is one function because the spec makes it one contract ("must never be
 *  dropped"): the map had it, search had a bare keyline, and the request
 *  viewer had neither a breadcrumb nor a mode block. */
export interface SurfaceBreadcrumbOptions {
  /** Mode name without padding — the cell inverts around it. */
  mode: string;
  modeBackground?: DisplayRole;
  /** What this surface is showing right now: a map view, a search scope. */
  scope: string;
  title: string;
  /** The name the writer gave this line, or "" when it has none. */
  identity: string;
  identityRole: DisplayRole;
  /** Where you are inside it — the `¶ n/m` slot. */
  crumb: string;
  /** The keyline, already built. It is reserved before identity is spent. */
  keys: FrameLine;
  width: number;
}

export function renderSurfaceBreadcrumb(options: SurfaceBreadcrumbOptions): FrameLine {
  const { mode, scope, title, identity, identityRole, crumb, keys, width } = options;
  const modeCell = ` ${mode} `;
  const scopeCell = scope.length === 0 ? " " : ` ${scope}  `;
  const keysWidth = lineWidth(keys);
  const available = Math.max(0, width - keysWidth - 1);
  const separators = identity.length === 0 ? 1 : 2;
  const fixed = visibleWidth(modeCell) + visibleWidth(scopeCell)
    + visibleWidth(" · ") * separators + visibleWidth(crumb);
  const [titleWidth, nameWidth] = saturatingIdentityWidths(
    title, identity, Math.max(0, available - fixed)
  );
  const shownName = truncate(identity, nameWidth);
  const left: FrameLine = [
    {
      text: modeCell,
      role: "background",
      background: options.modeBackground ?? "focus / accent",
      bold: true
    },
    segment(scopeCell, "focus / accent"),
    segment(truncate(title, titleWidth), "chrome"),
    ...(shownName.length === 0
      ? []
      : [segment(" · ", "chrome"), segment(shownName, identityRole)]),
    segment(` · ${crumb}`, "chrome")
  ];
  const shownLeft = fitLine(left, available);
  const gap = Math.max(1, width - lineWidth(shownLeft) - keysWidth);
  return [...shownLeft, segment(" ".repeat(gap), "chrome"), ...keys];
}

/** Spend every identity cell. A short title or line yields its unused share to
 * the other instead of leaving both truncated by a rigid percentage split. */
export function saturatingIdentityWidths(
  title: string,
  name: string,
  room: number
): [number, number] {
  const titleCells = visibleWidth(title);
  const nameCells = visibleWidth(name);
  let titleWidth = Math.min(titleCells, Math.floor(room * 0.5));
  let nameWidth = Math.min(nameCells, room - titleWidth);
  let remaining = room - titleWidth - nameWidth;
  const titleGrowth = Math.min(remaining, titleCells - titleWidth);
  titleWidth += titleGrowth;
  remaining -= titleGrowth;
  nameWidth += Math.min(remaining, nameCells - nameWidth);
  return [titleWidth, nameWidth];
}
