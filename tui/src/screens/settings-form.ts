import { graphemeCells } from "../cell-width.js";
import { composerPosition } from "../composer-model.js";
import type { HitRegion, HitTarget } from "../hit.js";
import {
  scalarInvalidReason,
  scalarTrack,
  typedScalarValue,
  type SettingsScalar
} from "../settings-scalar.js";
import {
  settingsEditDisplayComposer,
  SETTINGS_SECTIONS,
  type SettingsRowPresentation,
  type SettingsSectionId
} from "../settings-overlay-model.js";
import type { SettingsInlineEditState } from "../state.js";
import { wrapText } from "../wrap.js";
import { raisedSegment } from "./overlay.js";
import { renderComposerInput } from "./story/composer.js";
import {
  truncate,
  visibleWidth,
  type DisplayRole,
  type FrameLine
} from "./story/frame.js";

/** F-3's shared column budget: label 12, so the value column starts at 14 on
 *  every surface and stacked components line up without anyone measuring. The
 *  hint truncates; it never wraps.
 *
 *  There is no jump rail. It repeated every section name beside the rule that
 *  already carried it, and spent thirteen columns doing so — the grouping the
 *  rail was there to show is what `── light ──` already says. */
const LEAD_WIDTH = 2;
const LABEL_WIDTH = 12;
/** What a plain value gets before its position dots. */
const VALUE_WIDTH = 22;
/** A C-08 chip is short and its track needs the cells the value column would
 *  otherwise reserve, so scalars align on a narrower column of their own. */
const SCALAR_CHIP_WIDTH = 13;
/** C-08: 15 cells at 120 columns, dropped below 80. */
const TRACK_CELLS = 15;
/** Widest bound label a track prints on either side. */
const BOUND_WIDTH = 6;
/** Every control — chip, chip plus dots, chip plus track — is drawn into this
 *  one column, so the hints beside them line up in a single column too. That
 *  ragged right edge was the whole reason the form read as chaos. */
const CONTROL_WIDTH = SCALAR_CHIP_WIDTH + 1 + BOUND_WIDTH + 1 + TRACK_CELLS + 1 + BOUND_WIDTH;
/** Below this the track goes and the chip keeps the row on its own. */
const TRACK_MIN_PANEL_WIDTH = 80;
/** A hint narrower than this says nothing useful, so it yields its cells. */
const HINT_MIN_WIDTH = 8;
/** Cells the hint column asks for before the control column may take the rest.
 *  A narrow panel spends them on the sentence rather than on a track — which
 *  is also C-08's own degradation: the track drops, the chip stays. */
const HINT_TARGET_WIDTH = 24;

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
  for (const section of SETTINGS_SECTIONS) {
    const fields = options.rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => row.section === section.id);
    if (fields.length === 0) continue;
    painted.push({
      line: sectionRule(section.id, section.label, cursorSection, options.contentWidth),
      // The rule names the section and jumps to it, so the section heading is
      // one thing on screen rather than two.
      target: null,
      overrides: [{
        target: { kind: "action", action: "focus-index", index: fields[0]!.index },
        left: 0,
        right: options.contentWidth
      }]
    });
    for (const { row, index } of fields) {
      painted.push(fieldRow(row, index, options));
      painted.push(...noteRows(row, index, options));
    }
  }
  return painted;
}

/** C-07's note line: the sentence a row sometimes has to say, indented to the
 *  value column and wrapped there.
 *
 *  Without it the hint slot held four things at once — a standing hint, a
 *  refusal reason, an action label and an action's result — resolved by
 *  ranking, which is how a refusal reason could lose its row. Now the hint
 *  keeps the one-liner and the note takes whatever needs a sentence. */
function noteRows(
  row: SettingsRowPresentation,
  index: number,
  options: SettingsFormOptions
): SettingsFormRow[] {
  if (index !== options.cursor) return [];
  // While a scalar is being typed, its own limit is the note: F-2 says the
  // reason shows live and typing is never blocked. Text the row cannot read at
  // all says so, rather than reporting the last value it could.
  if (options.edit !== null) {
    if (row.scalar === undefined) return [];
    const typed = typedScalarValue(row.scalar, options.edit.composer.text);
    const reason = "refused" in typed ? typed.refused : scalarInvalidReason(typed.scalar);
    return reason === null
      ? []
      : noteLines(index, { text: reason, role: "danger text" }, options);
  }
  const report = options.actionReport?.row === row.id ? options.actionReport : null;
  const note = row.invalid !== undefined
    ? { text: row.invalid, role: "danger text" as DisplayRole }
    : report !== null
      ? {
        text: report.text,
        role: (report.ok ? "focus / accent" : "danger text") as DisplayRole
      }
      : null;
  if (note === null) return [];
  return noteLines(index, note, options);
}

/** C-07's note line, indented to the value column. */
function noteLines(
  index: number,
  note: { text: string; role: DisplayRole },
  options: SettingsFormOptions
): SettingsFormRow[] {
  const inset = LEAD_WIDTH + LABEL_WIDTH;
  const measure = Math.max(8, options.contentWidth - inset - 2);
  return wrapText(note.text, [], measure).map((line): SettingsFormRow => ({
    line: [
      raisedSegment(" ".repeat(inset), "chrome"),
      raisedSegment(`· ${line.text}`, note.role)
    ],
    target: { kind: "list", index },
    overrides: []
  }));
}

function sectionRule(
  id: SettingsSectionId,
  label: string,
  cursorSection: SettingsSectionId | null,
  contentWidth: number
): FrameLine {
  const here = id === cursorSection;
  const rule = `── ${label} `;
  const width = Math.max(0, contentWidth - LEAD_WIDTH);
  return [
    raisedSegment(" ".repeat(LEAD_WIDTH), "chrome"),
    raisedSegment(truncate(rule, width), here ? "accent · deep" : "chrome"),
    raisedSegment("─".repeat(Math.max(0, width - visibleWidth(rule))), "dimmed page")
  ];
}

function fieldRow(
  row: SettingsRowPresentation,
  index: number,
  options: SettingsFormOptions
): SettingsFormRow {
  const selected = index === options.cursor;
  const edit = selected && options.edit?.kind === "inline" ? options.edit : null;
  const bodyWidth = Math.max(1, options.contentWidth);
  const lead = selected ? "▸ " : "  ";
  const labelWidth = Math.min(LABEL_WIDTH, Math.max(4, bodyWidth - 8));
  const valueLeft = LEAD_WIDTH + labelWidth;
  const line: FrameLine = [
    raisedSegment(lead, selected ? "focus / accent" : "chrome"),
    raisedSegment(
      padTo(truncate(row.label, labelWidth), labelWidth),
      selected ? "prose" : "chrome"
    )
  ];
  const valueRoom = Math.max(1, bodyWidth - LEAD_WIDTH - labelWidth);
  if (edit !== null) {
    // C-07 editing state: `‹ ›` becomes `[ ]` and the block caret takes over.
    // A scalar keeps its track through it, following what is being typed, so
    // an out-of-range keystroke pins the handle instead of blanking the row.
    const parsed = row.scalar === undefined
      ? null
      : typedScalarValue(row.scalar, edit.composer.text);
    const typed = parsed !== null && "scalar" in parsed ? parsed.scalar : null;
    const field = Math.min(
      row.scalar === undefined ? valueRoom : SCALAR_CHIP_WIDTH,
      valueRoom
    );
    const displayComposer = settingsEditDisplayComposer(edit);
    line.push(
      raisedSegment("[", "chrome"),
      ...renderComposerInput(
        displayComposer, 0, composerPosition(displayComposer).column,
        Math.max(1, field - 2), "streaming", false, ""
      ),
      raisedSegment("]", "chrome")
    );
    const editTrack = typed === null || options.terminalWidth < TRACK_MIN_PANEL_WIDTH
      ? null
      : trackSegments(typed, Math.max(0, valueRoom - field));
    if (editTrack !== null) line.push(raisedSegment(" "), ...editTrack.segments);
    return { line, target: { kind: "list", index }, overrides: [] };
  }
  const invalid = row.invalid !== undefined;
  // Never wider than the cells the row actually has: the arrow regions are
  // measured off this column, and a bracket past the paint bound would leave a
  // click target on a cell nobody sees.
  const control = Math.min(
    valueRoom,
    CONTROL_WIDTH,
    Math.max(VALUE_WIDTH, valueRoom - HINT_TARGET_WIDTH)
  );
  const chipWidth = Math.min(
    row.scalar === undefined ? VALUE_WIDTH : SCALAR_CHIP_WIDTH,
    control
  );
  const valueRole: DisplayRole = invalid ? "danger text"
    : selected ? "focus / accent" : "prose";
  const drawn = truncate(row.value, chipWidth);
  line.push(raisedSegment(padTo(drawn, chipWidth), valueRole));
  let used = chipWidth;
  const dots = row.dots ?? "";
  if (dots.length > 0 && used + visibleWidth(dots) + 2 <= control) {
    line.push(raisedSegment(`${dots}  `, selected ? "accent · deep" : "chrome"));
    used += visibleWidth(dots) + 2;
  }
  const track = row.scalar === undefined
    || options.terminalWidth < TRACK_MIN_PANEL_WIDTH
    ? null
    : trackSegments(row.scalar, Math.max(0, control - used));
  if (track !== null) {
    line.push(...track.segments);
    used += track.width;
  }
  // Pad the control column out so every hint begins in one column, whatever
  // the row is carrying.
  if (used < control) {
    line.push(raisedSegment(" ".repeat(control - used)));
    used = control;
  }
  const hintRoom = Math.max(0, valueRoom - used - 2);
  // C-18's action label sits in the value column, where `tab` reaches it. Its
  // result, and F-2's refusal reason, take the note line below instead — the
  // hint slot holds one one-liner and never has to rank four claimants.
  const hint: { text: string; role: DisplayRole } = row.action !== undefined && selected
    ? { text: `[ ${row.action.label} ]  tab`, role: "accent · deep" }
    : { text: row.hint, role: "chrome" };
  if (hintRoom >= HINT_MIN_WIDTH && hint.text.length > 0) {
    line.push(raisedSegment("  "), raisedSegment(truncate(hint.text, hintRoom), hint.role));
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
    ...(labels.handle === null
      ? []
      : [raisedSegment(labels.handle, "focus / accent")]),
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
