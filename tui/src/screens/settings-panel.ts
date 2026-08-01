import { graphemeCells } from "../cell-width.js";
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
import {
  visibleWidth,
  type FrameComposition,
  type FrameLine
} from "./story/frame.js";

/** C-03's example in the library *is* settings: a 13-col jump rail beside the
 * form. The panel is wider than the other overlays because the rail, the field
 * grid and a C-08 track have to fit beside one another. */
const SETTINGS_PANEL_WIDTH = 96;

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
  // The bottom strip keeps its padded height whatever it says, so a pending
  // restart cannot lift the panel and move every field with it. The sectioned
  // form always fills the panel, so trading the strip for one more field row
  // would make that lift happen on exactly the frame the notice appears.
  //
  // Complete notices outrank fields: a selected row can scroll away for a
  // moment, but an error must not lose its final wrapped rows. On a panel too
  // short for both, the fields yield entirely — no error reads as no problem.
  const fixedRows = status.top.length + status.bottom.length + resultLines.length;
  const shown = contentCapacity < fixedRows + 1
    ? []
    : (() => {
      const window = panelRowWindow(
        painted.map(() => 1),
        picker === null
          ? paintedRowOffset(painted, boundedSettingsCursor(overlay.cursor))
          : boundedModelPickerCursor(
            overlay.modelPicker!.cursor,
            modelPickerRows(overlay, overlay.modelPicker!.query).length
          ),
        Math.max(1, contentCapacity - fixedRows - (picker === null ? 0 : 1))
      );
      // The filter row holds the live query and the count; it is chrome above
      // the column, not the first option, so it never scrolls away.
      const filter: SettingsFormRow[] = picker === null
        ? []
        : [{ line: picker.filter, target: null, overrides: [] }];
      return [...filter, ...painted.slice(window.start, window.end)];
    })();
  const leading = shown.length === 0
    ? shortPanelNotices([resultLines, status.top, status.bottom], contentCapacity)
    : status.top;
  const trailing = shown.length === 0 ? [] : [...status.bottom, ...resultLines];
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
      footerActions: footer.actions
    }
  );
}

/** Where a settings row landed among the painted rows. The form already knows
 *  — it tagged each row with its own index — so nothing re-walks the grouping. */
function paintedRowOffset(painted: readonly SettingsFormRow[], index: number): number {
  const at = painted.findIndex((row) =>
    row.target?.kind === "list" && row.target.index === index);
  return at < 0 ? 0 : at;
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
/** A probe reports what the provider said, and a provider says whatever it
 * likes. Clipping that to the panel width used to cut the sentence mid-word —
 * often exactly where the reason was — so the notice wraps instead, aligned
 * under its own glyph. Its rows are counted as fixed panel rows, so the fields
 * yield to it rather than the frame overflowing. */
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
  const lead = "  ";
  const glyph = ready ? "✓" : "▲";
  // The continuation indent clears the glyph so the wrapped sentence reads as
  // one block rather than as several notices.
  const indent = `${lead}${" ".repeat(visibleWidth(glyph) + 1)}`;
  const budget = Math.max(1, contentWidth - visibleWidth(indent));
  const words = overlay.result.message.split(/\s+/u).filter((word) => word.length > 0);
  const rows: string[] = [];
  let row = "";
  for (const word of words) {
    const candidate = row.length === 0 ? word : `${row} ${word}`;
    if (visibleWidth(candidate) <= budget) {
      row = candidate;
      continue;
    }
    if (row.length > 0) rows.push(row);
    // A single token longer than the panel — a URL, a model ID — is broken
    // across rows rather than dropped.
    row = word;
    while (visibleWidth(row) > budget) {
      // Take exactly the cells this row renders, then continue from the next
      // one. Ellipsizing here would both mark a break that is not an end and
      // drop the character it replaced.
      const taken = cutPoint(row, budget);
      rows.push(row.slice(0, taken));
      row = row.slice(taken);
    }
  }
  if (row.length > 0) rows.push(row);
  return (rows.length === 0 ? [""] : rows).map((text, index) =>
    [raisedSegment(`${index === 0 ? `${lead}${glyph} ` : indent}${text}`, role)]);
}

/** How many characters of an oversized token fit, leaving room for nothing —
 * the row is continued rather than marked, because the rest follows. */
function cutPoint(value: string, budget: number): number {
  let used = 0;
  let index = 0;
  for (const cell of graphemeCells(value)) {
    if (used + cell.width > budget) break;
    used += cell.width;
    index += cell.text.length;
  }
  return Math.max(1, index);
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

/** The tallest `bottom` variant: a separating blank, then the pending pair. */
const BOTTOM_STATUS_ROWS = 3;

/** Pads a bottom notice to a constant height, anchored to the footer.
 *
 * `placePanel` centres the panel on its content, so a variant one line taller
 * moves the panel top up and drags every field and hit target with it. Before
 * this notice moved below the fields, the extra pending line pushed them back
 * down by the same row and hid the effect; below the fields nothing cancels it.
 * Reserving the tallest variant's height keeps the whole panel still, which is
 * what the position was chosen for.
 */
function bottomStatus(lines: FrameLine[]): FrameLine[] {
  const padding = Array.from({ length: BOTTOM_STATUS_ROWS - lines.length }, (): FrameLine => []);
  return [...padding, ...lines];
}

