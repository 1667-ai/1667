import type { KeyAction } from "../../keys.js";
import type { StoryPart } from "../../model.js";
import type { ThoughtGutterContext } from "../../reasoning-model.js";
import { takeStrip } from "./density.js";
import {
  fitLine,
  segment,
  visibleWidth,
  type DisplayRole,
  type FrameLine,
  type FrameSegment
} from "./frame.js";
import type { FrameDeadlineCollector } from "../../animation-deadline.js";
import {
  asideGhostGutterLine,
  asidePresenceGutterRows,
  type AsidePresence
} from "../../aside-presence.js";
import { lightWorkKeyword, streamLivenessMark } from "../work-light.js";
import {
  focusedFoldedThoughtLine,
  ghostThoughtMark,
  thinkingGutterLine0,
  thinkingGutterLine1
} from "./thought-block.js";

export interface GutterVerb { token: string | null; label: string; action: KeyAction }

export const GUTTER_VERBS: ReadonlyArray<readonly GutterVerb[]> = [
  [{ token: "␠", label: "continue", action: "continue" }, { token: "↵", label: "direct", action: "compose" }],
  [{ token: "r", label: "retake", action: "regenerate" }, { token: "R", label: "reprompt", action: "retake-with-prompt" }],
  [{ token: "w", label: "write", action: "write" }, { token: "e", label: "edit", action: "edit" }]
];

const GUTTER_VERB_COLUMN_GAP = 2;

function gutterVerbLabel(verb: GutterVerb): string {
  return verb.token === null ? verb.label : `${verb.token} ${verb.label}`;
}

/** Widest label in each menu column. Derived from the verbs themselves so a
 * relabelled verb re-measures instead of drifting out of its column. */
const GUTTER_VERB_COLUMNS: readonly number[] = GUTTER_VERBS.reduce<number[]>((columns, row) => {
  row.forEach((verb, index) => {
    columns[index] = Math.max(columns[index] ?? 0, visibleWidth(gutterVerbLabel(verb)));
  });
  return columns;
}, []);

/** Every verb row is padded to this one width. The gutter is right-aligned, so
 * a uniform width is what gives the menu a single left edge and a shared second
 * column instead of a different indent per row. */
const GUTTER_VERB_WIDTH = GUTTER_VERB_COLUMNS.reduce(
  (total, column, index) => total + column + (index === 0 ? 0 : GUTTER_VERB_COLUMN_GAP),
  0
);

export function actionHint(text: string, action: KeyAction, role: DisplayRole = "chrome"): FrameSegment {
  return segment(text, role, { kind: "inline-action", action });
}

function gutterVerbSegments(row: readonly GutterVerb[]): FrameLine {
  const line = row.flatMap((verb, index): FrameLine => {
    const label = gutterVerbLabel(verb);
    const pad = (GUTTER_VERB_COLUMNS[index] ?? 0) - visibleWidth(label);
    return [
      ...(index === 0 ? [] : [segment(" ".repeat(GUTTER_VERB_COLUMN_GAP))]),
      actionHint(label, verb.action),
      ...(pad > 0 ? [segment(" ".repeat(pad))] : [])
    ];
  });
  // Squaring the row off to the block width is what makes the right-aligned
  // gutter give every verb row the same left edge.
  return fitLine(line, GUTTER_VERB_WIDTH);
}

function takeCounterSegments(part: StoryPart): FrameLine {
  return [
    actionHint("‹", "take-previous", "focus / accent"),
    segment(` take ${part.takeIndex}/${part.siblingCount} `, "focus / accent"),
    actionHint("›", "take-next", "focus / accent")
  ];
}

function takeCounterWidth(part: StoryPart): number {
  return takeCounterSegments(part).reduce((sum, item) => sum + visibleWidth(item.text), 0);
}

function stripSegments(strip: ReturnType<typeof takeStrip>, currentTake: number): FrameLine {
  if (strip.density === "gauge") {
    return [
      segment(strip.text.slice(0, strip.currentOffset), "chrome"),
      segment(strip.text[strip.currentOffset] ?? "", "focus / accent",
        { kind: "story-take", take: currentTake }),
      segment(strip.text.slice(strip.currentOffset + 1), "chrome")
    ];
  }
  const spacing = strip.density === "spaced" ? " " : "";
  // The strip owns the glyphs so the ring rule lives in one place; this only
  // colours them and hangs a click target on each take.
  return strip.cells.map((glyph, index): FrameLine => [
    ...(index === 0 ? [] : [segment(spacing, "chrome")]),
    segment(glyph, index + 1 === currentTake ? "focus / accent" : "chrome",
      { kind: "story-take", take: index + 1 })
  ]).flat();
}

/** The focused gutter's rows, in paint order: the part header (folded into
 *  the take counter when there are siblings), the take-strip row when there
 *  are siblings, the folded-thought row when there is one to show, then the
 *  verb menu. Built once per row so the row's height (`rows.length`) and its
 *  per-line content come from the same list instead of two hand-synchronised
 *  descriptions — the caller (`row-layout.ts`'s `layoutStoryRow`) is the only
 *  place `gutterFor` ever sees a non-null `rows`, and it only builds this
 *  list when the row is focused, not narrow, not streaming and not a
 *  summary, so a summary part never reaches the thought-row check below. */
export function gutterRowsFor(
  part: StoryPart,
  thought: ThoughtGutterContext,
  asidePresence: AsidePresence | null = null
): FrameLine[] {
  const rows: FrameLine[] = [];
  if (part.siblingCount > 1) {
    rows.push([segment(`¶ ${part.number} `, "chrome"), ...takeCounterSegments(part)]);
    const strip = takeStrip(part.takeIndex, part.siblingCount, part.takeSubtakes);
    const segments = stripSegments(strip, part.takeIndex);
    // Pad the strip out to the counter above it so the right-aligned gutter
    // starts both on the same column: the dots read as belonging to the
    // counter rather than as a third indent.
    const width = segments.reduce((sum, item) => sum + visibleWidth(item.text), 0);
    const pad = takeCounterWidth(part) - width;
    rows.push(pad > 0 ? [...segments, segment(" ".repeat(pad))] : segments);
  } else {
    rows.push([segment(`¶ ${part.number}`, "chrome")]);
  }
  if (asidePresence !== null) {
    rows.push(...asidePresenceGutterRows(part, asidePresence));
  }
  if (thought.kind === "shown" && thought.folded) rows.push(focusedFoldedThoughtLine(thought.hit));
  for (const verbs of GUTTER_VERBS) rows.push(gutterVerbSegments(verbs));
  return rows;
}

/** The streaming gutter's two fixed lines: `writing`/`esc stops`, or, while
 *  reasoning arrives with no prose yet, `thinking`/`esc peeks`. Built once so
 *  `gutterFor`'s per-line lookup and `row-layout.ts`'s sticky-gutter length
 *  can never drift apart the way two hand-derived formulas could. */
export function streamingGutterRows(
  part: StoryPart,
  thought: ThoughtGutterContext,
  now: number,
  deadlines?: FrameDeadlineCollector
): FrameLine[] {
  // Reasoning is arriving and no prose has started: swap the usual
  // writing/esc-stops pair for thinking/esc-peeks. Once prose starts, or once
  // `reasoning` is off, this falls through to the ordinary pair —
  // `thought.thinking` is already false in both cases (see
  // `thoughtGutterContext`).
  if (thought.kind === "shown" && thought.thinking) {
    return [thinkingGutterLine0(thought.resolved.tokenCount, now, deadlines), thinkingGutterLine1(thought.hit)];
  }
  return [
    lightWorkKeyword(
      [segment(`${streamLivenessMark(now, deadlines)} writing`, "focus / accent")],
      "writing",
      now,
      deadlines
    ),
    [actionHint("esc stops", "cancel")]
  ];
}

export function gutterFor(
  part: StoryPart,
  streaming: boolean,
  lineIndex: number,
  thought: ThoughtGutterContext,
  rows: readonly FrameLine[] | null,
  now = 0,
  deadlines?: FrameDeadlineCollector,
  asidePresence: AsidePresence | null = null
): FrameLine {
  if (streaming) {
    return streamingGutterRows(part, thought, now, deadlines)[lineIndex] ?? [];
  }
  // Focused, not narrow, not streaming, not a summary: `rows` was built once
  // by `gutterRowsFor` in `layoutStoryRow` and carries this line's content —
  // the row's own height (`rows.length`) already came from the same list.
  if (rows !== null) return rows[lineIndex] ?? [];
  if (lineIndex === 0) {
    if (part.isSummary) return [segment("◈", "summary")];
    if (asidePresence !== null && asidePresence.currentCount > 0) {
      return asideGhostGutterLine(asidePresence, part.siblingCount);
    }
    if (part.siblingCount > 1) return [segment(`×${part.siblingCount}`, "chrome")];
    // No fork tick or summary diamond claims this row's one unfocused gutter
    // cell: give the ghost thought word the cell instead. A part that has
    // both a fork count and a thought keeps the fork count — the reader's
    // place in the tree outranks a decorative margin word, and focusing the
    // part still reveals `thought · T shows` a moment later.
    if (thought.kind === "shown" && thought.folded) return ghostThoughtMark(thought.hit);
  }
  return [];
}
