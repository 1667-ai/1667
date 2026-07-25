import { composerPosition } from "../composer-model.js";
import type { HitRegion, HitRows, HitTarget } from "../hit.js";
import type { KeyAction } from "../keys.js";
import {
  boundedSettingsCursor,
  settingsEditDisplayComposer,
  settingsDraftChanged,
  settingsRowCycles,
  settingsRows,
  SETTINGS_ROW_IDS
} from "../settings-overlay-model.js";
import type { OverlayState } from "../state.js";
import { dimPage, panelWidthFor, placePanel, raisedSegment } from "./overlay.js";
import { panelRowWindow } from "./panel-table-layout.js";
import { renderComposerInput } from "./story/composer.js";
import {
  truncate,
  visibleWidth,
  type FrameComposition,
  type FrameLine
} from "./story/frame.js";

export const SETTINGS_FOOTER_ACTIONS = [
  { token: "↑", action: "focus-previous" },
  { token: "↓", action: "focus-next" },
  { token: "←", action: "take-previous" },
  { token: "→ choose", action: "take-next" },
  { token: "↵ next", action: "open-selected" },
  { token: "s save", action: "save-edit" },
  { token: "c check", action: "check" },
  { token: "esc close", action: "cancel" }
] as const satisfies ReadonlyArray<{ token: string; action: KeyAction }>;

const SETTINGS_TEXT_FOOTER_ACTIONS = [
  { token: "↑", action: "focus-previous" },
  { token: "↓", action: "focus-next" },
  { token: "↵ edit", action: "open-selected" },
  { token: "s save", action: "save-edit" },
  { token: "c check", action: "check" },
  { token: "esc close", action: "cancel" }
] as const satisfies ReadonlyArray<{ token: string; action: KeyAction }>;

const SETTINGS_CONTEXT_FOOTER_ACTIONS = [
  { token: "↑", action: "focus-previous" },
  { token: "↓", action: "focus-next" },
  { token: "↵ edit", action: "open-selected" },
  { token: "p detect", action: "detect-context" },
  { token: "s save", action: "save-edit" },
  { token: "c check", action: "check" },
  { token: "esc close", action: "cancel" }
] as const satisfies ReadonlyArray<{ token: string; action: KeyAction }>;

const SETTINGS_EDIT_FOOTER_ACTIONS = [
  { token: "←", action: "cursor-left" },
  { token: "→", action: "cursor-right" },
  { token: "↵ keep", action: "commit-field" },
  { token: "esc cancel", action: "cancel" }
] as const satisfies ReadonlyArray<{ token: string; action: KeyAction }>;

/** Settings rows wear the same `  ▸ ` cursor lead as every other list panel,
 * so `›` stays the prompt glyph it is everywhere else. */
const SETTINGS_LEAD_WIDTH = 4;
const SETTINGS_LABEL_WIDTH = 17;
/** Column the value starts in, relative to the content line. */
const SETTINGS_VALUE_LEFT = SETTINGS_LEAD_WIDTH + SETTINGS_LABEL_WIDTH;

const SETTINGS_PENDING_FOOTER_ACTIONS = [
  { token: "c check", action: "check" },
  { token: "x discard", action: "discard-pending" },
  { token: "esc close", action: "cancel" }
] as const satisfies ReadonlyArray<{ token: string; action: KeyAction }>;

interface SettingsFooter {
  text: string;
  actions: ReadonlyArray<{ token: string; action: KeyAction }>;
}

const SETTINGS_CHOICE_FOOTERS: ReadonlyArray<SettingsFooter> = [
  {
    text: "↑↓ move · ←→ choose · ↵ next · s save · c check · esc close",
    actions: SETTINGS_FOOTER_ACTIONS
  },
  {
    text: "↑↓ · ←→ choose · ↵ next · s · c · esc",
    actions: [
      { token: "↑", action: "focus-previous" },
      { token: "↓", action: "focus-next" },
      { token: "←", action: "take-previous" },
      { token: "→ choose", action: "take-next" },
      { token: "↵ next", action: "open-selected" },
      { token: "s", action: "save-edit" },
      { token: "c", action: "check" },
      { token: "esc", action: "cancel" }
    ]
  },
  {
    text: "↑↓ ←→ ↵ esc",
    actions: [
      { token: "↑", action: "focus-previous" },
      { token: "↓", action: "focus-next" },
      { token: "←", action: "take-previous" },
      { token: "→", action: "take-next" },
      { token: "↵", action: "open-selected" },
      { token: "esc", action: "cancel" }
    ]
  }
];

const SETTINGS_TEXT_FOOTERS: ReadonlyArray<SettingsFooter> = [
  {
    text: "↑↓ move · ↵ edit · s save · c check · esc close",
    actions: SETTINGS_TEXT_FOOTER_ACTIONS
  },
  {
    text: "↑↓ · ↵ edit · s · c · esc",
    actions: [
      { token: "↑", action: "focus-previous" },
      { token: "↓", action: "focus-next" },
      { token: "↵ edit", action: "open-selected" },
      { token: "s", action: "save-edit" },
      { token: "c", action: "check" },
      { token: "esc", action: "cancel" }
    ]
  },
  {
    text: "↑↓ ↵ esc",
    actions: [
      { token: "↑", action: "focus-previous" },
      { token: "↓", action: "focus-next" },
      { token: "↵", action: "open-selected" },
      { token: "esc", action: "cancel" }
    ]
  }
];

const SETTINGS_CONTEXT_FOOTERS: ReadonlyArray<SettingsFooter> = [
  {
    text: "↑↓ move · ↵ edit · p detect · s save · c check · esc close",
    actions: SETTINGS_CONTEXT_FOOTER_ACTIONS
  },
  {
    text: "↑↓ · ↵ edit · p detect · s · c · esc",
    actions: [
      { token: "↑", action: "focus-previous" },
      { token: "↓", action: "focus-next" },
      { token: "↵ edit", action: "open-selected" },
      { token: "p detect", action: "detect-context" },
      { token: "s", action: "save-edit" },
      { token: "c", action: "check" },
      { token: "esc", action: "cancel" }
    ]
  },
  {
    text: "↑↓ ↵ p esc",
    actions: [
      { token: "↑", action: "focus-previous" },
      { token: "↓", action: "focus-next" },
      { token: "↵", action: "open-selected" },
      { token: "p", action: "detect-context" },
      { token: "esc", action: "cancel" }
    ]
  }
];

const SETTINGS_EDIT_FOOTERS: ReadonlyArray<SettingsFooter> = [
  {
    text: "←→ cursor · ↵ keep row · esc cancel",
    actions: SETTINGS_EDIT_FOOTER_ACTIONS
  },
  {
    text: "←→ · ↵ keep · esc",
    actions: [
      { token: "←", action: "cursor-left" },
      { token: "→", action: "cursor-right" },
      { token: "↵ keep", action: "commit-field" },
      { token: "esc", action: "cancel" }
    ]
  },
  {
    text: "←→ ↵ esc",
    actions: [
      { token: "←", action: "cursor-left" },
      { token: "→", action: "cursor-right" },
      { token: "↵", action: "commit-field" },
      { token: "esc", action: "cancel" }
    ]
  }
];

const SETTINGS_PENDING_FOOTERS: ReadonlyArray<SettingsFooter> = [
  {
    text: "c check · x discard · esc close",
    actions: SETTINGS_PENDING_FOOTER_ACTIONS
  },
  {
    text: "c · x · esc",
    actions: [
      { token: "c", action: "check" },
      { token: "x", action: "discard-pending" },
      { token: "esc", action: "cancel" }
    ]
  }
];

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
  const panelWidth = panelWidthFor(width, 76);
  const valueWidth = Math.max(1, panelWidth - 2 - SETTINGS_VALUE_LEFT);
  const resultVisible = overlay.checking || overlay.probing || overlay.result !== null;
  const fixedRows = 3 + status.length + (resultVisible ? 1 : 0);
  const editableRows = rows.slice(2);
  const renderedRows = rows.map((row, index) =>
    settingsLine(row.label, row.value, index, overlay, valueWidth)
  );
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
  // placePanel can show at most height - 9 content rows (and retains a
  // two-row minimum at its smallest supported height). At short heights,
  // notices become compact chrome and the cursor-centered row window wins.
  const contentCapacity = Math.max(2, height - 9);
  let content: FrameLine[];
  let targets: Array<HitTarget | null>;
  if (contentCapacity < fixedRows + 1) {
    const notices = [
      ...(resultLine === null ? [] : [resultLine]),
      ...status.filter((line) => line.length > 0)
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
      ...status,
      ...renderedRows.slice(rowWindow.start + 2, rowWindow.end + 2),
      ...(resultLine === null ? [] : [resultLine])
    ];
    targets = [
      listTarget(0),
      listTarget(1),
      null,
      ...status.map(() => null),
      ...editableRows
        .slice(rowWindow.start, rowWindow.end)
        .map((_, index) => listTarget(rowWindow.start + index + 2)),
      ...(resultLine === null ? [] : [null])
    ];
  }

  const overrides: HitRegion[][] = content.map(() => []);
  // Every closed-choice row carries its own arrows, and the action names the
  // row so a click moves the cursor there first — mouse and keyboard then act
  // on the same row.
  for (const [selectorIndex, selector] of rows.entries()) {
    if (!settingsRowCycles(selector.id)) continue;
    const selectorRow = targets.findIndex((target) =>
      target?.kind === "list" && target.index === selectorIndex
    );
    if (selectorRow < 0 || overlay.edit?.row === selector.id) continue;
    const selectorLeft = SETTINGS_VALUE_LEFT;
    // Measure the value as drawn. An override past the painted text would stay
    // clickable — `hitAt` consults overrides before row bounds.
    const selectorWidth = visibleWidth(truncate(selector.value, valueWidth));
    overrides[selectorRow] = [
      {
        target: { kind: "action", action: "take-previous", index: selectorIndex },
        left: selectorLeft,
        right: selectorLeft + 1
      },
      {
        target: { kind: "action", action: "take-next", index: selectorIndex },
        left: selectorLeft + selectorWidth - 1,
        right: selectorLeft + selectorWidth
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
  const footer = fittingFooter(footerVariants, panelWidth - 4);
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

function fittingFooter(
  variants: ReadonlyArray<SettingsFooter>,
  availableWidth: number
): SettingsFooter {
  return variants.find((variant) => visibleWidth(variant.text) <= availableWidth)
    ?? variants.at(-1)!;
}

function settingsStatusLines(
  overlay: NonNullable<OverlayState["settings"]>
): FrameLine[] {
  const view = overlay.view;
  if (!view.editable) {
    return [
      [raisedSegment("  ▲ legacy data format 1 · settings are read-only until migration", "danger text")],
      []
    ];
  }
  if (view.pendingRevision !== null) {
    return [
      [
        raisedSegment(
          `  ⟳ revision ${view.pendingRevision} pending restart · active revision ${view.activeRevision} still running`,
          "focus / accent"
        )
      ],
      [raisedSegment("  editing frozen · x discards the pending candidate", "chrome")],
      []
    ];
  }
  if (settingsDraftChanged(overlay)) {
    return [
      [
        raisedSegment(
          `  ● unsaved draft · revision ${view.activeRevision} active · s saves`,
          "focus / accent"
        )
      ],
      []
    ];
  }
  return [[raisedSegment(`  ✓ revision ${view.activeRevision} active`, "chrome")], []];
}

function settingsLine(
  label: string,
  value: string,
  index: number,
  overlay: NonNullable<OverlayState["settings"]>,
  valueWidth: number
): FrameLine {
  const selected = index === overlay.cursor;
  const edit = selected ? overlay.edit : null;
  const prefix = raisedSegment(
    `${selected ? "  ▸ " : "    "}${label.padEnd(SETTINGS_LABEL_WIDTH)}`,
    selected ? "focus / accent" : "chrome"
  );
  if (edit === null) {
    return [
      prefix,
      raisedSegment(
        truncate(value, valueWidth),
        selected ? "focus / accent" : "prose"
      )
    ];
  }
  const displayComposer = settingsEditDisplayComposer(edit);
  return [
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
  ];
}

function listTarget(index: number): HitTarget {
  return { kind: "list", index };
}
