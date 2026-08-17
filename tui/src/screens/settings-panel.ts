import type { HitRegion, HitRows, HitTarget } from "../hit.js";
import {
  boundedSettingsCursor,
  settingsActivationFailureText,
  settingsDraftChanged,
  settingsRowHasArrows,
  settingsRows,
  SETTINGS_ROW_IDS
} from "../settings-overlay-model.js";
import type { OverlayState, SettingsRowId } from "../state.js";
import {
  dimPage,
  panelContentRows,
  panelHorizontalGeometry,
  placePanel,
  raisedSegment
} from "./overlay.js";
import { panelRowWindow } from "./panel-table-layout.js";
import { settingsFieldRow } from "./settings-field-row.js";
import {
  fittingFooter,
  settingsFooterVariants
} from "./settings-panel-footers.js";
import {
  settingsFormRows,
  type SettingsFormRow
} from "./settings-form.js";
import { modelPickerColumn } from "./settings-model-column.js";
import {
  boundedModelPickerCursor,
  modelPickerRows
} from "../settings-model-picker.js";
import { wrapFeedback } from "./feedback-wrap.js";
import {
  truncate,
  visibleWidth,
  type FrameComposition,
  type FrameLine
} from "./story/frame.js";

/** C-03's example in the library *is* settings: a 13-col jump rail beside the
 * form. The panel is wider than the other overlays because the rail, the field
 * grid and a C-08 track have to fit beside one another. */
const SETTINGS_PANEL_WIDTH = 96;
/** Decision 24's cap for a result line. */
const RESULT_ROW_CAP = 3;
/** `!` is a page key, so the route out of Settings names both presses. */
const RESULT_OVERFLOW = "esc then ! for all of it";

type SettingsPanelState = Pick<OverlayState, "settings" | "config"> & {
  hitRows: HitRows;
};

export function renderSettingsPanel(
  base: FrameLine[],
  state: SettingsPanelState,
  width: number,
  height: number
): FrameComposition {
  const overlay = state.settings!;
  const rows = settingsRows(overlay, state.config);
  const horizontal = panelHorizontalGeometry(width, SETTINGS_PANEL_WIDTH);
  const contentCapacity = panelContentRows(height);
  const status = settingsStatusLines(overlay);
  const resultLines = settingsResultLines(overlay, horizontal.contentWidth);
  const picker = overlay.modelPicker === null
    ? null
    : modelPickerColumn(overlay, overlay.modelPicker, horizontal.contentWidth);
  const painted = picker?.choices ?? settingsFormRows({
    rows,
    cursor: boundedSettingsCursor(overlay.cursor),
    edit: overlay.edit,
    contentWidth: horizontal.contentWidth,
    terminalWidth: width,
    hasArrows: (row) => settingsRowHasArrows(overlay, row.id),
    actionReport: inPlaceActionReport(overlay)
  });
  // Complete notices outrank fields: a selected row can scroll away for a
  // moment, but an error must not lose its final wrapped rows. On a panel too
  // short for both, the fields yield entirely — no error reads as no problem.
  const fixedRows = status.top.length + status.bottom.length + resultLines.length;
  // One line in the existing bottom area tells the writer when the form
  // continues off-screen. If the full form fits, fields use that line too.
  const positionRows = picker === null
    && painted.length > Math.max(1, contentCapacity - fixedRows)
    ? 1
    : 0;
  const shown = contentCapacity < fixedRows + positionRows + 1
    ? []
    : (() => {
      const cursorOffset = picker === null
        ? paintedRowOffset(painted, boundedSettingsCursor(overlay.cursor))
        : boundedModelPickerCursor(
          overlay.modelPicker!.cursor,
          modelPickerRows(overlay, overlay.modelPicker!.query).length + 1
        );
      const formCapacity = Math.max(
        1,
        contentCapacity - fixedRows - positionRows - (picker === null ? 0 : 1)
      );
      const window = panelRowWindow(
        painted.map(() => 1),
        cursorOffset,
        formCapacity
      );
      // The filter row holds the live query and the count; it is chrome above
      // the column, not the first option, so it never scrolls away.
      const filter: SettingsFormRow[] = picker === null
        ? []
        : [{ line: picker.filter, target: null, overrides: [] }];
      // A field's note line is part of the field. Extend the window over the
      // rows that belong to the cursor so a refusal reason cannot fall off it.
      let start = window.start;
      let end = window.end;
      let noteContinues = false;
      const cursorRow = boundedSettingsCursor(overlay.cursor);
      const belongsToCursor = (row: SettingsFormRow | undefined): boolean => {
        const target = row?.target;
        return target !== undefined && target !== null
          && target.kind === "list" && target.index === cursorRow;
      };
      while (picker === null && end < painted.length && belongsToCursor(painted[end])) {
        if (end - start >= formCapacity) {
          if (start < cursorOffset) start += 1;
          else {
            noteContinues = true;
            break;
          }
        }
        end += 1;
      }
      const visible = painted.slice(start, end);
      if (noteContinues && visible.length > 0) {
        visible[visible.length - 1] = withContinuation(visible.at(-1)!);
      }
      return [...filter, ...visible];
    })();
  const leading = shown.length === 0
    ? shortPanelNotices([resultLines, status.top, status.bottom], contentCapacity)
    : status.top;
  const position = shown.length === 0 || picker !== null
    ? []
    : settingsPositionLines(shown, rows.length);
  const trailing = shown.length === 0
    ? []
    : [...position, ...status.bottom, ...resultLines];
  const content: FrameLine[] = [
    ...leading,
    ...shown.map((row) => row.line),
    ...trailing
  ];
  const targets: Array<HitTarget | null> = [
    ...leading.map(() => null),
    ...shown.map((row) => row.target),
    ...trailing.map(() => null)
  ];
  const overrides: HitRegion[][] = [
    ...leading.map((): HitRegion[] => []),
    ...shown.map((row) => row.overrides),
    ...trailing.map((): HitRegion[] => [])
  ];

  const footerVariants = settingsFooterVariants(overlay, picker !== null);
  const footer = fittingFooter(footerVariants, horizontal.footerWidth);
  return placePanel(
    dimPage(base),
    "settings",
    content,
    footer.text,
    width,
    height,
    SETTINGS_PANEL_WIDTH,
    {
      rows: state.hitRows,
      targets,
      overrides,
      footerActions: footer.actions,
      anchorTop: true
    }
  );
}

/** Mark a selected description that has more physical lines than the panel. */
function withContinuation(row: SettingsFormRow): SettingsFormRow {
  const line = [...row.line];
  const final = line.at(-1);
  if (final === undefined) return row;
  line[line.length - 1] = {
    ...final,
    text: truncate(`${final.text} …`, visibleWidth(final.text))
  };
  return { ...row, line };
}

/** Where a settings row landed among the painted rows. The form already knows
 *  — it tagged each row with its own index — so nothing re-walks the grouping. */
function paintedRowOffset(painted: readonly SettingsFormRow[], index: number): number {
  const at = painted.findIndex((row) =>
    row.target?.kind === "list" && row.target.index === index);
  return at < 0 ? 0 : at;
}

/** Use the panel's bottom area to state how much of the Settings list is off
 * screen. Counts are logical settings, not section rules or wrapped notes. */
function settingsPositionLines(
  shown: readonly SettingsFormRow[],
  total: number
): FrameLine[] {
  const visible = shown.flatMap((row) => {
    const target = row.target;
    return target?.kind === "list" && target.index !== undefined ? [target.index] : [];
  });
  if (visible.length === 0) return [];
  const above = visible[0]!;
  const below = Math.max(0, total - visible.at(-1)! - 1);
  if (above === 0 && below === 0) return [];
  const parts = [
    ...(above > 0 ? [`↑ ${above} earlier setting${above === 1 ? "" : "s"}`] : []),
    ...(below > 0 ? [`↓ ${below} more setting${below === 1 ? "" : "s"}`] : [])
  ];
  return [[raisedSegment(`  ${parts.join(" · ")}`, "chrome")]];
}


/** A notice taller than the panel keeps the rows that fit rather than
 *  vanishing: a wrapped provider error is several rows, and dropping the block
 *  whole would show no error at all on a short terminal. */
function shortPanelNotices(
  blocks: readonly FrameLine[][],
  capacity: number
): FrameLine[] {
  const notices: FrameLine[] = [];
  for (const block of blocks) {
    const rows = block.filter((line) => line.length > 0);
    if (rows.length === 0) continue;
    const room = capacity - notices.length;
    if (room <= 0) break;
    notices.push(...rows.slice(0, room));
    if (rows.length > room) break;
  }
  return notices;
}

/** C-18: an action reports in place, to the right of what caused it, and keeps
 *  reporting until the next keypress. The one-word verdict rides the row; the
 *  provider's own sentence keeps the wrapped block below, where it has room to
 *  say why. */
function inPlaceActionReport(
  overlay: NonNullable<OverlayState["settings"]>
): { row: SettingsRowId; text: string; ok: boolean } | null {
  // Three rows write the one result slot, so each names itself: reporting a
  // failed context probe beside the base URL tells the writer the endpoint is
  // broken when the probe was.
  if (overlay.checking) return { row: "base-url", text: "⟳ checking…", ok: true };
  if (overlay.probing) return { row: "context-window", text: "⟳ probing…", ok: true };
  if (overlay.discoveringModels) return { row: "model", text: "⟳ reading…", ok: true };
  if (overlay.result === null || overlay.resultRow === null) return null;
  const ready = overlay.result.state === "ready";
  return {
    row: overlay.resultRow,
    text: ready ? "✓ ready" : "▲ failed",
    ok: ready
  };
}

/** The panel's two notice positions.
 *
 * `top` is for a precondition: something that changes what every field below it
 * means. It has to arrive before the fields, not after them.
 *
 * `bottom` is for the state of the document being edited. It sits with the
 * check result, above the footer that advertises the keys it names, because it
 * describes the whole panel rather than the row it happens to precede — and
 * because it grows by a line when a restart is pending, which mid-panel would
 * shift the field list out from under the cursor.
 *
 * Each `bottom` variant leads with a blank so the strip stands off the fields.
 */
/** A provider says whatever it likes, and decision 24's cap applies to it like
 * every other result line: three rows, the body truncating with `…`, and the
 * last row keeping the way out. The whole message is in the log, which `!`
 * opens once Settings has been closed. */
function settingsResultLines(
  overlay: NonNullable<OverlayState["settings"]>,
  contentWidth: number
): FrameLine[] {
  const progress = overlay.checking
    ? "checking model server…"
    : overlay.probing
      ? "detecting context window…"
      : overlay.discoveringModels
        ? "reading model list…"
        : null;
  if (progress !== null) {
    return [[raisedSegment(`  ⟳ ${progress}`, "focus / accent")]];
  }
  if (overlay.result === null) return [];
  const ready = overlay.result.state === "ready";
  const role = ready ? "focus / accent" : "danger text";
  const glyph = ready ? "✓" : "▲";
  const lead = "  ";
  // The continuation indent clears the glyph so the wrapped sentence reads as
  // one block rather than as several notices.
  const indent = `${lead}${" ".repeat(visibleWidth(glyph) + 1)}`;
  const budget = Math.max(1, contentWidth - visibleWidth(indent));
  const wrapped = wrapFeedback(overlay.result.message, budget, RESULT_ROW_CAP, RESULT_OVERFLOW);
  return wrapped.rows.map((text, index) =>
    [raisedSegment(`${index === 0 ? `${lead}${glyph} ` : indent}${text}`, role)]);
}

function settingsStatusLines(
  overlay: NonNullable<OverlayState["settings"]>
): { top: FrameLine[]; bottom: FrameLine[] } {
  const view = overlay.view;
  if (!view.editable) {
    return {
      top: [
        [raisedSegment("  ▲ legacy data format 1 · settings are read-only until migration", "danger text")],
        []
      ],
      bottom: []
    };
  }
  if (view.pendingRevision !== null) {
    // The server removes an outcome when its saved candidate is replaced or
    // discarded. Thus, this outcome always describes the pending save.
    const outcome = view.lastActivationOutcome;
    const failure = outcome !== null && outcome.result !== "committed"
      ? settingsActivationFailureText(outcome.errorCode)
      : null;
    return {
      top: [],
      bottom: bottomStatus([
        [
          raisedSegment(
            failure === null
              ? "  ⟳ settings saved · not active yet"
              : `  ▲ settings saved, not active · ${failure}`,
            failure === null ? "focus / accent" : "danger text"
          )
        ],
        [raisedSegment("  s retries activation · x discards the saved candidate", "chrome")]
      ])
    };
  }
  // A clean view with a failure outcome is a startup rollback. The failed
  // candidate is gone, but the Settings panel must report the failure.
  const rolledBack = view.lastActivationOutcome !== null
    && view.lastActivationOutcome.result !== "committed"
    ? view.lastActivationOutcome
    : null;
  if (rolledBack !== null) {
    return {
      top: [],
      bottom: bottomStatus([
        [
          raisedSegment(
            `  ▲ saved settings did not activate · ${settingsActivationFailureText(rolledBack.errorCode)}`,
            "danger text"
          )
        ],
        [raisedSegment("  previous settings still active · edit & s saves a new attempt", "chrome")]
      ])
    };
  }
  if (settingsDraftChanged(overlay)) {
    return {
      top: [],
      bottom: bottomStatus([
        [
          raisedSegment(
            "  ● unsaved draft · s saves",
            "focus / accent"
          )
        ]
      ])
    };
  }
  return {
    top: [],
    bottom: bottomStatus([])
  };
}

/** A status uses only the rows it needs. The form takes the remaining space. */
function bottomStatus(lines: FrameLine[]): FrameLine[] {
  return lines.length === 0 ? [] : [[], ...lines];
}
