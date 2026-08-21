import type { HitTarget } from "../../hit.js";
import { formatTokensScaled } from "../../rail.js";
import type { ResolvedThought } from "../../reasoning-model.js";
import { wrapText } from "../../wrap.js";
import type { FrameDeadlineCollector } from "../../animation-deadline.js";
import { lightWorkKeyword } from "../work-light.js";
import { segment, visibleWidth, type FrameLine } from "./frame.js";

/** Ghost role for every thought affordance — settings §13's "marker is a
 *  ghost word in the margin", and the design's own ghost swatch, which is
 *  exactly `THEMES.lantern["dimmed page"]`. Never a hex literal. */
const GHOST_ROLE = "dimmed page";
/** The rail that keeps an unfolded thought from reading as story prose. */
const RAIL_GLYPH = "┊";
/** Rail glyph plus one space — the hanging indent's own width, mirroring
 *  `renderChapterSummary`'s "  " (row-layout.ts) one column wider to make
 *  room for the rail itself. */
const RAIL_PREFIX_WIDTH = 2;

/** Unfocused line-0 waymark: a bare ghost word, nothing else. `×n`/`◈`
 *  (row-layout.ts's `gutterFor`) wins the same cell when both would land
 *  there — see the comment at that call site for why. */
export function ghostThoughtMark(hit: HitTarget): FrameLine {
  return [segment("thought", GHOST_ROLE, hit)];
}

/** Focused, folded line: `thought · T shows`. Its own gutter row, inserted
 *  ahead of `GUTTER_VERBS` — see `layoutStoryRow`'s `gutterRows` math. */
export function focusedFoldedThoughtLine(hit: HitTarget): FrameLine {
  return [
    segment("thought", GHOST_ROLE, hit),
    segment(" · ", GHOST_ROLE, hit),
    segment("T shows", GHOST_ROLE, hit)
  ];
}

/** The streaming gutter's two `thinking` lines — `gutterFor`'s replacement
 *  for `writing`/`esc stops` while reasoning is arriving and no prose has
 *  landed. Line 0 carries the count only when there is one worth printing;
 *  line 1 keeps `esc stops` in `gutterFor`'s own "chrome" (unchanged from
 *  the `writing` branch it stands in for) and adds `T peeks` in the same
 *  role, since this line is a status line, not the ghost-margin affordance
 *  the folded/unfolded marks are. */
export function thinkingGutterLine0(
  tokenCount: number | null,
  now = 0,
  deadlines?: FrameDeadlineCollector
): FrameLine {
  const label = tokenCount === null ? "⟳ thinking" : `⟳ thinking · ${tokenCount} tok`;
  return lightWorkKeyword([segment(label, "focus / accent")], "thinking", now, deadlines);
}

export function thinkingGutterLine1(hit: HitTarget): FrameLine {
  return [
    segment("esc stops", "chrome"),
    segment(" · ", "chrome"),
    segment("T peeks", "chrome", hit)
  ];
}

/** One rendered row of the unfolded block: gutter content (a label on the
 *  first two rows, blank after) paired with the ghost prose it sits beside.
 *  The caller (`row-layout.ts`'s `partPrefix`) wraps each pair with the same
 *  `prefixLine` every other prefix component uses. */
export interface ThoughtBlockRow {
  gutter: FrameLine;
  prose: FrameLine;
}

/** The unfolded thought: `thought · 1.4k` / `T folds` in the gutter, ghost
 *  text behind a `┊` rail with a 2-col hanging indent in the prose column —
 *  `renderChapterSummary`'s wrap-width math (row-layout.ts), one column
 *  narrower to leave room for the rail glyph itself. Loading and error states
 *  still show the fold hint (folding never needs the fetch to land) with a
 *  short ghost placeholder in place of the thought's own text. */
export function unfoldedThoughtBlock(
  hit: HitTarget,
  measure: number,
  resolved: ResolvedThought
): ThoughtBlockRow[] {
  const text = resolved.status === "loading" ? "loading…"
    : resolved.status === "error" ? "thought unavailable"
    : resolved.text;
  const wrapWidth = Math.max(12, measure - RAIL_PREFIX_WIDTH);
  const wrapped = wrapText(text, [], wrapWidth);
  const headerLabel = resolved.tokenCount === null
    ? "thought"
    : `thought · ${formatTokensScaled(resolved.tokenCount)}`;
  const gutterLines: FrameLine[] = [
    [segment(headerLabel, GHOST_ROLE, hit)],
    [segment("T folds", GHOST_ROLE, hit)]
  ];
  // `T folds` earns its own row even when the thought is short enough to
  // wrap to one line (or none, mid-load) — both gutter labels always show,
  // padded with blank, rail-less prose past the end of the ghost text
  // itself, the same way `renderPartBody` pads a short take out to its own
  // verb menu below.
  const rowCount = Math.max(wrapped.length, gutterLines.length);
  return Array.from({ length: rowCount }, (_, index): ThoughtBlockRow => {
    const line = wrapped[index];
    return {
      gutter: index < gutterLines.length ? gutterLines[index]! : [],
      prose: line === undefined ? [] : [
        segment(RAIL_GLYPH, "chrome"),
        segment(" ".repeat(RAIL_PREFIX_WIDTH - visibleWidth(RAIL_GLYPH)), GHOST_ROLE),
        { ...segment(line.text, GHOST_ROLE), prose: true }
      ]
    };
  });
}
