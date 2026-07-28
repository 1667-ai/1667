import { graphemeCells } from "../cell-width.js";
import { composerPosition } from "../composer-model.js";
import type { HitRegion, HitRows, HitTarget } from "../hit.js";
import {
  boundedSettingsCursor,
  settingsActivationFailureText,
  settingsEditDisplayComposer,
  settingsDraftChanged,
  settingsRowCycles,
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
  const status = settingsStatusLines(overlay);
  const horizontal = panelHorizontalGeometry(width, 76);
  const resultVisible = overlay.checking || overlay.probing || overlay.result !== null;
  const fixedRows = 3 + status.top.length + status.bottom.length + (resultVisible ? 1 : 0);
  const editableRows = rows.slice(2);
  const painted = rows.map((row, index) =>
    settingsRow(row, index, overlay, horizontal.contentWidth)
  );
  const renderedRows = painted.map((row) => row.line);
  const resultLine: FrameLine | null = overlay.checking
    ? [raisedSegment("  ⟳ checking model server…", "focus / accent")]
    : overlay.probing
      ? [raisedSegment("  ⟳ detecting context window…", "focus / accent")]
      : overlay.result === null
        ? null
        : [
            raisedSegment(
              `  ${overlay.result.state === "ready" ? "✓" : "▲"} ${overlay.result.message}`,
              overlay.result.state === "ready" ? "focus / accent" : "danger text"
            )
          ];
  // At short heights, notices become compact chrome and the cursor-centered
  // row window wins whatever the panel can actually paint.
  const contentCapacity = panelContentRows(height);
  let content: FrameLine[];
  let targets: Array<HitTarget | null>;
  if (contentCapacity < fixedRows + 1) {
    const notices = [
      ...(resultLine === null ? [] : [resultLine]),
      ...[...status.top, ...status.bottom].filter((line) => line.length > 0)
    ];
    const noticeCount = Math.min(notices.length, Math.max(0, contentCapacity - 1));
    const rowCapacity = Math.max(1, contentCapacity - noticeCount);
    const rowWindow = panelRowWindow(
      rows.map(() => 1),
      overlay.cursor,
      rowCapacity
    );
    content = [
      ...notices.slice(0, noticeCount),
      ...renderedRows.slice(rowWindow.start, rowWindow.end)
    ];
    targets = [
      ...Array<HitTarget | null>(noticeCount).fill(null),
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
      ...(resultLine === null ? [] : [resultLine])
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
      ...(resultLine === null ? [] : [null])
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
  const choosing = !editing && settingsRowCycles(SETTINGS_ROW_IDS[boundedSettingsCursor(overlay.cursor)]!);
  const detecting = !editing && rows[overlay.cursor]?.id === "context-window";
  const footerVariants = editing
    ? SETTINGS_EDIT_FOOTERS
    : pending
      ? SETTINGS_PENDING_FOOTERS
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
    // The server nulls any outcome whose candidate was replaced or
    // discarded, so a staged view's outcome always describes this candidate.
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
              ? `  ⟳ revision ${view.pendingRevision} saved · not active yet · revision ${view.activeRevision} still running`
              : `  ▲ revision ${view.pendingRevision} saved, not active · ${failure}`,
            failure === null ? "focus / accent" : "danger text"
          )
        ],
        [raisedSegment("  s retries activation · x discards the saved candidate", "chrome")]
      ])
    };
  }
  // A clean view with a failure outcome is a startup rollback: the candidate
  // is gone, and staying silent about it is the exact failure class this
  // surface exists to prevent.
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
            `  ▲ revision ${rolledBack.candidateRevision} did not activate · ${settingsActivationFailureText(rolledBack.errorCode)}`,
            "danger text"
          )
        ],
        [raisedSegment(`  revision ${view.activeRevision} still active · edit & s saves a new attempt`, "chrome")]
      ])
    };
  }
  if (settingsDraftChanged(overlay)) {
    return {
      top: [],
      bottom: bottomStatus([
        [
          raisedSegment(
            `  ● unsaved draft · revision ${view.activeRevision} active · s saves`,
            "focus / accent"
          )
        ]
      ])
    };
  }
  return {
    top: [],
    bottom: bottomStatus([[raisedSegment(`  ✓ revision ${view.activeRevision} active`, "chrome")]])
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
  const edit = selected ? overlay.edit : null;
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
      arrows: settingsRowCycles(row.id)
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
