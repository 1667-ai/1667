import { graphemeCells } from "../cell-width.js";
import { composerPosition } from "../composer-model.js";
import type { HitRegion, HitRows, HitTarget } from "../hit.js";
import {
  boundedSettingsCursor,
  settingsActivationFailureText,
  settingsEditDisplayComposer,
  settingsDraftChanged,
  settingsRowHasArrows,
  settingsRows,
  SETTINGS_ROW_IDS,
  type SettingsRowPresentation
} from "../settings-overlay-model.js";
import type { OverlayState } from "../state.js";
import {
  dimPage,
  panelContentRows,
  panelHorizontalGeometry,
  placePanel,
  raisedSegment
} from "./overlay.js";
import { panelRowWindow } from "./panel-table-layout.js";
import {
  fittingFooter,
  SETTINGS_CHOICE_FOOTERS,
  SETTINGS_CONTEXT_FOOTERS,
  SETTINGS_EDIT_FOOTERS,
  SETTINGS_MODEL_FOOTERS,
  SETTINGS_PENDING_FOOTERS,
  SETTINGS_TEXT_FOOTERS
} from "./settings-panel-footers.js";
import { renderComposerInput } from "./story/composer.js";
import {
  truncate,
  visibleWidth,
  type FrameComposition,
  type FrameLine
} from "./story/frame.js";

/** Settings rows wear the same `  ▸ ` cursor lead as every other list panel,
 * so `›` stays the prompt glyph it is everywhere else. */
const SETTINGS_LEAD_WIDTH = 4;
/** Wide enough for every label the panel has, so all the values start in one
 * column. A test holds the labels to it. */
const SETTINGS_LABEL_WIDTH = 20;

/** Column the value starts in, relative to the content line. Only
 * `settingsRow` reads this, because only `settingsRow` paints the value.
 *
 * A label too wide for the column pushes its own value right and keeps one
 * cell of air. That row alone leaves the column, which the test reports. The
 * arrows stay on the brackets, because they come from this same number. A
 * constant here put them on the label instead. */
function settingsValueLeft(label: string): number {
  return SETTINGS_LEAD_WIDTH + Math.max(SETTINGS_LABEL_WIDTH, visibleWidth(label) + 1);
}

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
  const horizontal = panelHorizontalGeometry(width, 76);
  const contentCapacity = panelContentRows(height);
  const status = settingsStatusLines(overlay);
  const resultLines = settingsResultLines(overlay, horizontal.contentWidth);
  const fixedRows = 3 + status.top.length
    + status.bottom.length + resultLines.length;
  const editableRows = rows.slice(2);
  const painted = rows.map((row, index) =>
    settingsRow(row, index, overlay, horizontal.contentWidth)
  );
  const renderedRows = painted.map((row) => row.line);
  // At short heights, notices become compact chrome and the cursor-centered
  // row window wins whatever the panel can actually paint.
  let content: FrameLine[];
  let targets: Array<HitTarget | null>;
  if (contentCapacity < fixedRows + 1) {
    const noticeBlocks = [
      ...(resultLines.length === 0 ? [] : [resultLines]),
      status.top.filter((line) => line.length > 0),
      status.bottom.filter((line) => line.length > 0)
    ];
    const notices: FrameLine[] = [];
    const noticeCapacity = contentCapacity;
    for (const block of noticeBlocks) {
      if (block.length === 0) continue;
      const room = noticeCapacity - notices.length;
      if (room <= 0) break;
      // A notice taller than the panel keeps the rows that fit rather than
      // vanishing. A wrapped provider error is several rows now, so dropping
      // the block whole would show no error at all on a short terminal —
      // and no error reads as no problem.
      notices.push(...block.slice(0, room));
      if (block.length > room) break;
    }
    // Complete notices outrank fields in a short panel. A selected row can
    // disappear temporarily; an error must not lose its final wrapped rows.
    const rowCapacity = Math.max(0, contentCapacity - notices.length);
    const rowWindow = rowCapacity === 0
      ? { start: 0, end: 0 }
      : panelRowWindow(rows.map(() => 1), overlay.cursor, rowCapacity);
    content = [
      ...notices,
      ...renderedRows.slice(rowWindow.start, rowWindow.end)
    ];
    targets = [
      ...notices.map(() => null),
      ...rows
        .slice(rowWindow.start, rowWindow.end)
        .map((_, index) => listTarget(rowWindow.start + index))
    ];
  } else {
    const rowWindow = panelRowWindow(
      editableRows.map(() => 1),
      Math.max(0, overlay.cursor - 2),
      contentCapacity - fixedRows
    );
    content = [
      renderedRows[0]!,
      renderedRows[1]!,
      [],
      ...status.top,
      ...renderedRows.slice(rowWindow.start + 2, rowWindow.end + 2),
      ...status.bottom,
      ...resultLines
    ];
    targets = [
      listTarget(0),
      listTarget(1),
      null,
      ...status.top.map(() => null),
      ...editableRows
        .slice(rowWindow.start, rowWindow.end)
        .map((_, index) => listTarget(rowWindow.start + index + 2)),
      ...status.bottom.map(() => null),
      ...resultLines.map(() => null)
    ];
  }

  const overrides: HitRegion[][] = content.map(() => []);
  // Every closed-choice row carries its own arrows, and the action names the
  // row so a click moves the cursor there first — mouse and keyboard then act
  // on the same row. The columns come from the row that painted the brackets,
  // so no second opinion about the drawn value can move an arrow off one.
  for (const [selectorIndex, selector] of painted.entries()) {
    if (selector.arrows === null) continue;
    const selectorRow = targets.findIndex((target) =>
      target?.kind === "list" && target.index === selectorIndex
    );
    if (selectorRow < 0) continue;
    overrides[selectorRow] = [
      {
        target: { kind: "action", action: "take-previous", index: selectorIndex },
        left: selector.arrows.previous,
        right: selector.arrows.previous + 1
      },
      {
        target: { kind: "action", action: "take-next", index: selectorIndex },
        left: selector.arrows.next,
        right: selector.arrows.next + 1
      }
    ];
  }

  const pending = overlay.view.editable && overlay.view.pendingRevision !== null;
  const editing = overlay.edit !== null;
  const selectedRow = SETTINGS_ROW_IDS[boundedSettingsCursor(overlay.cursor)]!;
  const choosing = !editing && settingsRowHasArrows(overlay, selectedRow);
  const detecting = !editing && rows[overlay.cursor]?.id === "context-window";
  const footerVariants = editing
    ? SETTINGS_EDIT_FOOTERS
    : pending
      ? SETTINGS_PENDING_FOOTERS
      : choosing && selectedRow === "model"
        ? SETTINGS_MODEL_FOOTERS
        : choosing
          ? SETTINGS_CHOICE_FOOTERS
          : detecting
            ? SETTINGS_CONTEXT_FOOTERS
            : SETTINGS_TEXT_FOOTERS;
  const footer = fittingFooter(footerVariants, horizontal.footerWidth);
  return placePanel(
    dimPage(base),
    "settings",
    content,
    footer.text,
    width,
    height,
    76,
    {
      rows: state.hitRows,
      targets,
      overrides,
      footerActions: footer.actions
    }
  );
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

/** A painted row, and where it put the arrows of a closed choice.
 *
 * `arrows` is `null` when the row is not a closed choice, when the composer
 * owns it, or when the panel is too narrow to paint the closing bracket. The
 * caller must not place a hit region then: `hitAt` consults overrides before
 * row bounds, so an override past the painted glyph would stay clickable. */
interface PaintedSettingsRow {
  readonly line: FrameLine;
  readonly arrows: { readonly previous: number; readonly next: number } | null;
}

function settingsRow(
  row: SettingsRowPresentation,
  index: number,
  overlay: NonNullable<OverlayState["settings"]>,
  contentWidth: number
): PaintedSettingsRow {
  const selected = index === overlay.cursor;
  const edit = selected && overlay.edit?.kind === "inline"
    ? overlay.edit
    : null;
  const valueLeft = settingsValueLeft(row.label);
  const valueWidth = Math.max(1, contentWidth - valueLeft);
  const lead = `${selected ? "  ▸ " : "    "}${row.label}`;
  const prefix = raisedSegment(
    lead + " ".repeat(valueLeft - visibleWidth(lead)),
    selected ? "focus / accent" : "chrome"
  );
  if (edit === null) {
    const drawn = truncate(row.value, valueWidth);
    return {
      line: [
        prefix,
        raisedSegment(drawn, selected ? "focus / accent" : "prose")
      ],
      arrows: settingsRowHasArrows(overlay, row.id)
        ? bracketArrows(drawn, valueLeft)
        : null
    };
  }
  const displayComposer = settingsEditDisplayComposer(edit);
  return {
    line: [
      prefix,
      raisedSegment("[", "chrome"),
      ...renderComposerInput(
        displayComposer,
        0,
        composerPosition(displayComposer).column,
        Math.max(1, valueWidth - 2),
        "streaming",
        false,
        ""
      ),
      raisedSegment("]", "chrome")
    ],
    arrows: null
  };
}

/** A closed choice opens on its first cell and closes on its bracket. The
 * detail a row may add after that bracket is not part of the choice. */
function bracketArrows(
  drawn: string,
  valueLeft: number
): PaintedSettingsRow["arrows"] {
  const cells = graphemeCells(drawn);
  const opening = cells[0]?.text;
  if (opening !== "‹" && opening !== "[") return null;
  let column = 0;
  for (const cell of cells) {
    if (column > 0 && (cell.text === "›" || cell.text === "]")) {
      return { previous: valueLeft, next: valueLeft + column };
    }
    column += cell.width;
  }
  return null;
}

function listTarget(index: number): HitTarget {
  return { kind: "list", index };
}
