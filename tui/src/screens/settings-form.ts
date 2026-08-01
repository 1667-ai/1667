import { graphemeCells } from "../cell-width.js";
import { composerPosition } from "../composer-model.js";
import type { HitRegion, HitTarget } from "../hit.js";
import { scalarTrack, type SettingsScalar } from "../settings-scalar.js";
import {
  settingsEditDisplayComposer,
  SETTINGS_SECTIONS,
  type SettingsRowPresentation,
  type SettingsSectionId
} from "../settings-overlay-model.js";
import type { SettingsInlineEditState } from "../state.js";
import { raisedSegment } from "./overlay.js";
import { renderComposerInput } from "./story/composer.js";
import {
  truncate,
  visibleWidth,
  type DisplayRole,
  type FrameLine
} from "./story/frame.js";

/** C-03's jump rail. Thirteen cells, and the `│` after it runs on every row. */
export const RAIL_WIDTH = 13;
const DIVIDER = "│";
/** Cells between the divider and the body's first column. */
const RAIL_INSET = RAIL_WIDTH + visibleWidth(DIVIDER) + 1;
/** Below this the rail costs the hint column more than the jump is worth, so
 *  the split collapses and the section rules carry the grouping alone. The
 *  rail is an affordance, not information — nothing is lost by dropping it. */
const RAIL_MIN_WIDTH = 100;

/** C-07's field row, widened by the four cells the longest label here needs:
 *  label 16 · value 22 · hint flex. The hint truncates; it never wraps. */
const LABEL_WIDTH = 16;
const VALUE_WIDTH = 22;
/** A C-08 chip is short and its track needs the cells the value column would
 *  otherwise reserve, so scalars align on a narrower column of their own. */
const SCALAR_CHIP_WIDTH = 13;
/** C-08: 15 cells at 120 columns, dropped below 80. */
const TRACK_CELLS = 15;
/** Below this the track goes and the chip keeps the row on its own. */
const TRACK_MIN_PANEL_WIDTH = 80;
/** A hint narrower than this says nothing useful, so it yields its cells. */
const HINT_MIN_WIDTH = 8;

/** One painted form row and everything the panel needs to make it clickable. */
export interface SettingsFormRow {
  readonly line: FrameLine;
  readonly target: HitTarget | null;
  readonly overrides: HitRegion[];
}

export interface SettingsFormOptions {
  readonly rows: readonly SettingsRowPresentation[];
  readonly cursor: number;
  readonly edit: SettingsInlineEditState | null;
  readonly contentWidth: number;
  readonly terminalWidth: number;
  /** Rows the arrows act on, by row id. */
  readonly hasArrows: (row: SettingsRowPresentation) => boolean;
  /** What a C-18 action reports, drawn in place to the right of the row. */
  readonly actionReport: { readonly row: SettingsRowPresentation["id"]; readonly text: string; readonly ok: boolean } | null;
}

/** The whole form: a section rule and its fields, section after section, with
 *  the rail beside them. Returns one entry per painted row so the panel keeps
 *  its hit map aligned with what was drawn. */
export function settingsFormRows(options: SettingsFormOptions): SettingsFormRow[] {
  const painted: SettingsFormRow[] = [];
  const cursorSection = options.rows[options.cursor]?.section ?? null;
  const rail = options.terminalWidth >= RAIL_MIN_WIDTH;
  for (const section of SETTINGS_SECTIONS) {
    const fields = options.rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => row.section === section.id);
    if (fields.length === 0) continue;
    painted.push({
      line: sectionRule(section.id, section.label, cursorSection, options.contentWidth, rail),
      target: null,
      overrides: []
    });
    for (const { row, index } of fields) {
      painted.push(fieldRow(row, index, options, rail));
    }
  }
  return painted;
}

/** How many rows the form paints, so the panel can budget for its notices. */
export function settingsFormHeight(rows: readonly SettingsRowPresentation[]): number {
  const sections = new Set(rows.map((row) => row.section));
  return rows.length + sections.size;
}

/** Which painted row a settings row landed on, for cursor-centred windowing. */
export function settingsFormRowOffset(
  rows: readonly SettingsRowPresentation[],
  index: number
): number {
  const target = rows[index];
  if (target === undefined) return 0;
  let offset = 0;
  for (const section of SETTINGS_SECTIONS) {
    const fields = rows.filter((row) => row.section === section.id);
    if (fields.length === 0) continue;
    offset += 1;
    for (const row of fields) {
      if (row === target) return offset;
      offset += 1;
    }
  }
  return offset;
}

function sectionRule(
  id: SettingsSectionId,
  label: string,
  cursorSection: SettingsSectionId | null,
  contentWidth: number,
  rail: boolean
): FrameLine {
  const here = id === cursorSection;
  const rule = `── ${label} `;
  const width = Math.max(0, contentWidth - bodyInset(rail));
  return [
    ...railGutter(label, here, rail),
    raisedSegment(truncate(rule, width), here ? "accent · deep" : "chrome"),
    raisedSegment("─".repeat(Math.max(0, width - visibleWidth(rule))), "dimmed page")
  ];
}

function bodyInset(rail: boolean): number {
  return rail ? RAIL_INSET : 2;
}

/** The rail cell and the divider that runs on every row, or the plain indent
 *  the collapsed form uses instead. */
function railGutter(label: string, here: boolean, rail: boolean): FrameLine {
  if (!rail) return [raisedSegment("  ", "chrome")];
  return [railCell(label, here), raisedSegment(`${DIVIDER} `, "brass dim")];
}

function railCell(label: string, here: boolean): FrameLine[number] {
  const text = label.length === 0 ? "" : ` ${truncate(label, RAIL_WIDTH - 2)}`;
  return raisedSegment(
    text + " ".repeat(Math.max(0, RAIL_WIDTH - visibleWidth(text))),
    here ? "focus / accent" : "chrome"
  );
}

function fieldRow(
  row: SettingsRowPresentation,
  index: number,
  options: SettingsFormOptions,
  rail: boolean
): SettingsFormRow {
  const selected = index === options.cursor;
  const edit = selected && options.edit?.kind === "inline" ? options.edit : null;
  const inset = bodyInset(rail);
  const bodyWidth = Math.max(1, options.contentWidth - inset);
  const lead = selected ? "▸ " : "  ";
  const labelWidth = Math.min(LABEL_WIDTH, Math.max(4, bodyWidth - 8));
  const valueLeft = inset + visibleWidth(lead) + labelWidth;
  const line: FrameLine = [
    ...railGutter("", false, rail),
    raisedSegment(lead, selected ? "focus / accent" : "chrome"),
    raisedSegment(
      padTo(truncate(row.label, labelWidth), labelWidth),
      selected ? "prose" : "chrome"
    )
  ];
  const valueRoom = Math.max(1, bodyWidth - visibleWidth(lead) - labelWidth);
  if (edit !== null) {
    // C-07 editing state: `‹ ›` becomes `[ ]` and the block caret takes over.
    const displayComposer = settingsEditDisplayComposer(edit);
    line.push(
      raisedSegment("[", "chrome"),
      ...renderComposerInput(
        displayComposer, 0, composerPosition(displayComposer).column,
        Math.max(1, valueRoom - 2), "streaming", false, ""
      ),
      raisedSegment("]", "chrome")
    );
    return { line, target: { kind: "list", index }, overrides: [] };
  }
  const invalid = row.invalid !== undefined;
  const valueWidth = Math.min(
    row.scalar === undefined ? VALUE_WIDTH : SCALAR_CHIP_WIDTH,
    valueRoom
  );
  const valueRole: DisplayRole = invalid ? "danger text"
    : selected ? "focus / accent" : "prose";
  const drawn = truncate(row.value, valueWidth);
  line.push(raisedSegment(padTo(drawn, valueWidth), valueRole));
  let used = valueWidth;
  const dots = row.dots ?? "";
  if (dots.length > 0 && used + visibleWidth(dots) + 2 <= valueRoom) {
    line.push(raisedSegment(`${dots}  `, selected ? "accent · deep" : "chrome"));
    used += visibleWidth(dots) + 2;
  }
  const hint = invalid ? row.invalid! : row.hint;
  const candidate = row.scalar === undefined
    || options.terminalWidth < TRACK_MIN_PANEL_WIDTH
    ? null
    : trackSegments(row.scalar, Math.max(0, valueRoom - used));
  // F-2: the reason a value is refused must survive. It shares the row with a
  // pinned track where both fit, and takes the track's cells where they do not.
  const track = candidate !== null && invalid
    && valueRoom - used - candidate.width - 2 < visibleWidth(hint)
    ? null
    : candidate;
  if (track !== null) {
    line.push(...track.segments);
    used += track.width;
  }
  const hintRoom = Math.max(0, valueRoom - used - 2);
  const report = options.actionReport?.row === row.id ? options.actionReport : null;
  // C-18 reports in place, to the right of what caused it, and keeps reporting
  // until the next keypress — so a result outranks the row's standing hint.
  const trailing = report !== null
    ? { text: report.text, role: (report.ok ? "focus / accent" : "danger text") as DisplayRole }
    : row.action !== undefined && selected
      ? { text: `[ ${row.action.label} ]  tab`, role: "accent · deep" as DisplayRole }
      : { text: hint, role: (invalid ? "danger text" : "chrome") as DisplayRole };
  if (hintRoom >= HINT_MIN_WIDTH && trailing.text.length > 0) {
    line.push(raisedSegment("  "), raisedSegment(truncate(trailing.text, hintRoom), trailing.role));
  }
  return {
    line,
    target: { kind: "list", index },
    overrides: options.hasArrows(row) ? arrowRegions(drawn, valueLeft, index) : []
  };
}

function trackSegments(
  scalar: SettingsScalar,
  room: number
): { segments: FrameLine; width: number } | null {
  const labels = scalarTrack(scalar, TRACK_CELLS);
  if (labels === null) return null;
  const lead = `${labels.minLabel} `;
  const tail = ` ${labels.maxLabel}`;
  const width = visibleWidth(lead) + TRACK_CELLS + visibleWidth(tail);
  if (width > room) return null;
  const filled = "━".repeat(labels.filled);
  const rest = "━".repeat(labels.rest);
  const segments: FrameLine = [
    raisedSegment(lead, "chrome"),
    raisedSegment(withTick(filled, labels.tick, 0), "focus / accent"),
    raisedSegment(labels.handle, "focus / accent"),
    raisedSegment(withTick(rest, labels.tick, labels.filled + 1), "dimmed page"),
    raisedSegment(tail, "chrome")
  ];
  return { segments, width };
}

/** The `┊` tick marks where the default sits, drawn into whichever half of the
 *  track holds it. */
function withTick(run: string, tick: number | null, offset: number): string {
  if (tick === null) return run;
  const at = tick - offset;
  if (at < 0 || at >= run.length) return run;
  return `${run.slice(0, at)}┊${run.slice(at + 1)}`;
}

/** A closed choice opens on its first cell and closes on its bracket. */
function arrowRegions(drawn: string, valueLeft: number, index: number): HitRegion[] {
  const cells = graphemeCells(drawn);
  const opening = cells[0]?.text;
  if (opening !== "‹" && opening !== "[") return [];
  let column = 0;
  for (const cell of cells) {
    if (column > 0 && (cell.text === "›" || cell.text === "]")) {
      return [
        {
          target: { kind: "action", action: "take-previous", index },
          left: valueLeft,
          right: valueLeft + 1
        },
        {
          target: { kind: "action", action: "take-next", index },
          left: valueLeft + column,
          right: valueLeft + column + 1
        }
      ];
    }
    column += cell.width;
  }
  return [];
}

function padTo(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}
