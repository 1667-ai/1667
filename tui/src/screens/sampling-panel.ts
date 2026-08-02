import { composerPosition } from "../composer-model.js";
import type { HitRows, HitTarget } from "../hit.js";
import {
  boundedSamplingCursor,
  SAMPLING_LAYER_ROWS,
  samplingContextForOverlay,
  samplingLayerRowIdentity,
  samplingListItemIdentity,
  type SamplingListPanel,
  type SamplingListRow,
  type SamplingScalarRow,
  samplingListRows,
  samplingScalarRows
} from "../sampling-model.js";
import { samplingListPanelSpec } from "../sampling-panel-spec.js";
import { bannedStringValueRow, phraseBiasValueRow } from "./sampling-bias-panel.js";
import type { SamplingPhraseBiasEntryV2 } from "../../../shared/settings-v2-types.js";
import type { OverlayState } from "../state.js";
import {
  dimPage,
  panelContentRows,
  panelHorizontalGeometry,
  placePanel,
  raisedSegment
} from "./overlay.js";
import { panelRowWindow, cellPadStart } from "./panel-table-layout.js";
import { renderComposerInput } from "./story/composer.js";
import {
  truncate,
  visibleWidth,
  type DisplayRole,
  type FrameComposition,
  type FrameLine
} from "./story/frame.js";

type SamplingPanelState = Pick<OverlayState, "settings"> & { hitRows: HitRows };
type SamplingLayerRow =
  | { kind: "scalar"; row: SamplingScalarRow }
  | { kind: "list"; row: SamplingListRow };

const SAMPLING_PANEL_TITLES: Readonly<Record<SamplingListPanel, string>> = {
  stop: "stop sequences",
  "logit-bias": "logit bias",
  "phrase-bias": "phrase bias",
  "banned-strings": "banned strings"
};

export function renderSamplingPanel(
  base: FrameLine[],
  state: SamplingPanelState,
  width: number,
  height: number
): FrameComposition {
  const settings = state.settings!;
  const nested = settings.sampling!;
  const horizontal = panelHorizontalGeometry(width, 76);
  const contentWidth = horizontal.contentWidth;
  const status = nested.result === null ? [] : [samplingStatus(nested.result, contentWidth)];
  const content = nested.panel === "sampling"
    ? renderSamplingLayer(settings, contentWidth, height, status)
    : renderSamplingListLayer(settings, contentWidth, height, status, nested.panel);
  const footer = samplingFooter(nested.panel, nested.edit !== null, horizontal.footerWidth);
  return placePanel(
    dimPage(base),
    nested.panel === "sampling" ? "sampling" : SAMPLING_PANEL_TITLES[nested.panel],
    content.lines,
    footer.text,
    width,
    height,
    76,
    {
      rows: state.hitRows,
      targets: content.targets,
      footerActions: footer.actions
    }
  );
}

function renderSamplingLayer(
  settings: NonNullable<OverlayState["settings"]>,
  width: number,
  height: number,
  status: FrameLine[]
): { lines: FrameLine[]; targets: Array<HitTarget | null> } {
  const scalarRows = samplingScalarRows(settings);
  const listRows = samplingListRows(settings);
  const rows = [
    ...scalarRows.map((row) => ({ kind: "scalar" as const, row })),
    ...listRows.map((row) => ({ kind: "list" as const, row }))
  ];
  const cursor = boundedSamplingCursor(settings);
  // One reason held by every knob is a fact about the provider, not about any
  // row. Repeated down the column it was the loudest thing on the panel and
  // pushed each row's own value out of alignment.
  const shared = sharedDisabledReason(scalarRows, listRows);
  const sharedLine: FrameLine[] = shared === null
    ? []
    : [[raisedSegment(truncate(`  ${shared}`, width), "prose · dim")]];
  const capacity = Math.max(1,
    panelContentRows(height) - status.length - sharedLine.length);
  const window = panelRowWindow(rows.map(() => 1), cursor, capacity);
  const lines: FrameLine[] = [...status, ...sharedLine];
  const targets: Array<HitTarget | null> = [
    ...status.map(() => null),
    ...sharedLine.map(() => null)
  ];
  for (const [offset, row] of rows.slice(window.start, window.end).entries()) {
    const index = window.start + offset;
    lines.push(renderSamplingRow(row, index === cursor, settings, width, shared !== null));
    const rowIdentity = row.kind === "scalar"
      ? samplingLayerRowIdentity({ kind: "scalar", knob: row.row.knob })
      : samplingLayerRowIdentity({ kind: "list", panel: row.row.panel });
    targets.push({
      kind: "list",
      index,
      rowId: rowIdentity,
      selected: index === cursor
    });
  }
  return { lines, targets };
}

/** The one reason every knob is disabled for, when there is exactly one. */
function sharedDisabledReason(
  scalars: readonly SamplingScalarRow[],
  lists: readonly SamplingListRow[]
): string | null {
  if (scalars.some((row) => row.available) || lists.some((row) => row.available)) {
    return null;
  }
  const reasons = new Set(scalars.map((row) => row.reason));
  return reasons.size === 1 ? [...reasons][0]! : null;
}

function renderSamplingRow(
  row: SamplingLayerRow,
  selected: boolean,
  settings: NonNullable<OverlayState["settings"]>,
  width: number,
  reasonShared: boolean
): FrameLine {
  const lead = selected ? "  ▸ " : "    ";
  if (row.kind === "scalar") {
    const edit = selected && settings.sampling?.edit?.kind === "scalar"
      ? settings.sampling.edit
      : null;
    if (edit !== null) {
      return inlineRow(lead, row.row.label, edit.composer, width);
    }
    return fieldRow(
      lead,
      row.row.label,
      row.row.available ? `‹ ${row.row.value} ›` : "‹ — ›",
      row.row.available || reasonShared ? "" : row.row.reason,
      width,
      selected,
      row.row.available ? "chrome" : "prose · dim"
    );
  }
  return fieldRow(
    lead,
    row.row.label,
    row.row.available ? `[${row.row.value}]` : "‹ — ›",
    row.row.available ? "↵ open" : reasonShared ? "" : `disabled · ${row.row.reasonCompact}`,
    width,
    selected,
    row.row.available ? "chrome" : "prose · dim"
  );
}

/** One render spec per list panel, paired with the model spec
 * (../sampling-panel-spec.js) by panel key. `formatValue` takes exactly one
 * cast, not a runtime narrowing throw: the value it receives always came
 * from this same panel's own `values()`, so the shape is already known. */
interface SamplingListRenderSpec {
  readonly emptyCopy: readonly string[];
  header(count: number, maximum: number): string;
  formatValue(
    value: unknown,
    settings: NonNullable<OverlayState["settings"]>,
    index: number,
    selected: boolean,
    width: number
  ): FrameLine;
}

const SAMPLING_LIST_RENDER_SPECS: Readonly<Record<SamplingListPanel, SamplingListRenderSpec>> = {
  stop: {
    emptyCopy: [
      "  no stop sequences yet.",
      "  n writes one · the model stops when it types one"
    ],
    header: (count, maximum) => `  #   stop sequence · ${count}/${maximum}`,
    formatValue: (value, _settings, index, selected, width) =>
      listValueRow(index, value as string, selected, width)
  },
  "logit-bias": {
    emptyCopy: [
      "  no biased tokens yet.",
      "  n writes one · token IDs come from the model's tokenizer."
    ],
    header: (count, maximum) => `  token ID       integer bias · ${count}/${maximum}`,
    formatValue: (value, _settings, _index, selected, width) => {
      const [token, weight] = value as readonly [string, number];
      return logitValueRow(token, weight, selected, width);
    }
  },
  "phrase-bias": {
    emptyCopy: [
      "  no phrase bias yet.",
      "  n writes one · phrase:integer bias · each phrase resolves to one or more tokens."
    ],
    header: (count, maximum) => `  phrase              bias  resolved tokens · ${count}/${maximum}`,
    formatValue: (value, settings, _index, selected, width) =>
      phraseBiasValueRow(value as SamplingPhraseBiasEntryV2, settings, selected, width)
  },
  "banned-strings": {
    emptyCopy: [
      "  no banned strings yet.",
      "  n writes one · a negative bias makes a string unlikely, not impossible."
    ],
    header: (count, maximum) => `  banned string             resolved tokens · ${count}/${maximum}`,
    formatValue: (value, settings, _index, selected, width) =>
      bannedStringValueRow(value as string, settings, selected, width)
  }
};

function renderSamplingListLayer(
  settings: NonNullable<OverlayState["settings"]>,
  width: number,
  height: number,
  status: FrameLine[],
  panel: SamplingListPanel
): { lines: FrameLine[]; targets: Array<HitTarget | null> } {
  const modelSpec = samplingListPanelSpec(panel);
  const renderSpec = SAMPLING_LIST_RENDER_SPECS[panel];
  const context = samplingContextForOverlay(settings);
  const values = modelSpec.values(settings);
  const maximum = modelSpec.maximum(context);
  const cursor = boundedSamplingCursor(settings, panel);
  const activeEdit = settings.sampling?.edit;
  const pendingEdit = activeEdit?.kind === "list" && activeEdit.panel === panel && activeEdit.index === values.length
    ? activeEdit
    : null;
  const header = [raisedSegment(truncate(renderSpec.header(values.length, maximum), width), "chrome")];
  const rows: FrameLine[] = [];
  const targets: Array<HitTarget | null> = [...status.map(() => null), null];
  if (values.length === 0) {
    for (const text of renderSpec.emptyCopy) {
      rows.push([raisedSegment(truncate(text, width), "prose · dim")]);
      targets.push(null);
    }
  }
  const rowCount = values.length + (pendingEdit === null ? 0 : 1);
  if (rowCount > 0) {
    const emptyCopyRows = values.length === 0 ? renderSpec.emptyCopy.length : 0;
    const capacity = Math.max(1, panelContentRows(height) - status.length - 1 - emptyCopyRows);
    const window = panelRowWindow(Array.from({ length: rowCount }, () => 1), cursor, capacity);
    for (let index = window.start; index < window.end; index += 1) {
      if (index === values.length && pendingEdit !== null) {
        rows.push(inlineListValueRow(index, pendingEdit.composer, width));
      } else {
        const value = values[index];
        if (value === undefined) continue;
        const edit = index === cursor && activeEdit?.kind === "list" && activeEdit.panel === panel
          ? activeEdit
          : null;
        rows.push(edit === null
          ? renderSpec.formatValue(value, settings, index, cursor === index, width)
          : inlineListValueRow(index, edit.composer, width));
      }
      const rowId = samplingListItemIdentity(
        panel,
        index === values.length ? null : modelSpec.identityKey(values[index]!),
        index === values.length && pendingEdit !== null
      );
      targets.push({
        kind: "list",
        index,
        ...(rowId === null ? {} : { rowId }),
        selected: index === cursor
      });
    }
  }
  return { lines: [...status, header, ...rows], targets };
}

function listValueRow(index: number, value: string, selected: boolean, width: number): FrameLine {
  const lead = selected ? "  ▸ " : "    ";
  return plainRow(`${lead}${String(index + 1).padStart(2, "0")}`, JSON.stringify(value), width, selected);
}

function logitValueRow(token: string, weight: number, selected: boolean, width: number): FrameLine {
  const lead = selected ? "  ▸ " : "    ";
  const left = `${lead}${cellPadStart(token, 12)}`;
  return [
    raisedSegment(left, selected ? "focus / accent" : "chrome"),
    raisedSegment(truncate(cellPadStart(String(weight), 8), Math.max(1, width - visibleWidth(left))), selected ? "focus / accent" : "prose")
  ];
}

function inlineListValueRow(index: number, composer: Parameters<typeof renderComposerInput>[0], width: number): FrameLine {
  const lead = `  ▸ ${index < 9 ? `0${index + 1}` : index + 1} `;
  return [
    raisedSegment(lead, "focus / accent"),
    raisedSegment("[", "chrome"),
    ...renderComposerInput(
      composer,
      0,
      composerPosition(composer).column,
      Math.max(1, width - visibleWidth(lead) - 2),
      "streaming",
      false,
      ""
    ),
    raisedSegment("]", "chrome")
  ];
}

function inlineRow(
  lead: string,
  label: string,
  composer: Parameters<typeof renderComposerInput>[0],
  width: number
): FrameLine {
  const prefix = `${lead}${label} `;
  return [
    raisedSegment(prefix, "focus / accent"),
    raisedSegment("[", "chrome"),
    ...renderComposerInput(
      composer,
      0,
      composerPosition(composer).column,
      Math.max(1, width - visibleWidth(prefix) - 2),
      "streaming",
      false,
      ""
    ),
    raisedSegment("]", "chrome")
  ];
}

/** The same three columns the settings form uses — label, control, hint. The
 *  label and the value used to share one string, so a longer knob name pushed
 *  its value right and the panel read as a ragged list rather than a grid. */
const SAMPLING_LABEL_WIDTH = 18;
const SAMPLING_VALUE_WIDTH = 12;

function fieldRow(
  lead: string,
  label: string,
  value: string,
  hint: string,
  width: number,
  selected: boolean,
  hintRole: DisplayRole = "chrome"
): FrameLine {
  const labelWidth = Math.min(SAMPLING_LABEL_WIDTH,
    Math.max(4, width - visibleWidth(lead) - 6));
  const room = Math.max(1, width - visibleWidth(lead) - labelWidth);
  const valueWidth = Math.min(SAMPLING_VALUE_WIDTH, room);
  const hintRoom = Math.max(0, room - valueWidth - 2);
  const line: FrameLine = [
    raisedSegment(lead, selected ? "focus / accent" : "chrome"),
    raisedSegment(pad(truncate(label, labelWidth), labelWidth),
      selected ? "prose" : "chrome"),
    raisedSegment(pad(truncate(value, valueWidth), valueWidth),
      selected ? "focus / accent" : "prose")
  ];
  if (hintRoom >= 4 && hint.length > 0) {
    line.push(raisedSegment("  "), raisedSegment(truncate(hint, hintRoom), hintRole));
  }
  return line;
}

function pad(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

function plainRow(prefix: string, value: string, width: number, selected: boolean): FrameLine {
  const prefixText = `${prefix} `;
  return [
    raisedSegment(prefixText, selected ? "focus / accent" : "chrome"),
    raisedSegment(
      truncate(value, Math.max(1, width - visibleWidth(prefixText))),
      selected ? "focus / accent" : "prose"
    )
  ];
}

function samplingStatus(text: string, width: number): FrameLine {
  const danger = text.includes("kept") || text.includes("disabled") || text.includes("limit");
  return [raisedSegment(truncate(`  ${danger ? "▲" : "●"} ${text}`, width), danger ? "danger text" : "focus / accent")];
}

interface SamplingFooter {
  readonly text: string;
  readonly actions: ReadonlyArray<{ token: string; action: "focus-previous" | "focus-next" | "open-selected" | "new-item" | "delete-item" | "take-previous" | "take-next" | "cursor-left" | "cursor-right" | "cancel" | "commit-field" }>;
}

function samplingFooter(
  panel: "sampling" | SamplingListPanel,
  editing: boolean,
  width: number
): SamplingFooter {
  if (editing) return footerFit([
    { text: "←→ cursor · ↵ keep · esc cancel", actions: [
      { token: "←", action: "cursor-left" }, { token: "→", action: "cursor-right" },
      { token: "↵ keep", action: "commit-field" }, { token: "esc", action: "cancel" }
    ] },
    { text: "←→ ↵ esc", actions: [
      { token: "←", action: "cursor-left" }, { token: "→", action: "cursor-right" },
      { token: "↵", action: "commit-field" }, { token: "esc", action: "cancel" }
    ] }
  ], width);
  if (panel === "sampling") return footerFit([
    { text: "↑↓ move · ←→ adjust · ↵ open · esc back", actions: [
      { token: "↑", action: "focus-previous" }, { token: "↓", action: "focus-next" },
      { token: "←", action: "take-previous" }, { token: "→", action: "take-next" },
      { token: "↵ open", action: "open-selected" },
      { token: "esc back", action: "cancel" }
    ] },
    { text: "↑↓ ←→ ↵ esc", actions: [
      { token: "↑", action: "focus-previous" }, { token: "↓", action: "focus-next" },
      { token: "←", action: "take-previous" }, { token: "→", action: "take-next" },
      { token: "↵", action: "open-selected" }, { token: "esc", action: "cancel" }
    ] }
  ], width);
  const reorderable = samplingListPanelSpec(panel).reorderable;
  const actions = [
    { token: "↑", action: "focus-previous" as const },
    { token: "↓", action: "focus-next" as const },
    { token: "↵ edit", action: "open-selected" as const },
    { token: "n add", action: "new-item" as const },
    { token: "d delete", action: "delete-item" as const },
    ...(reorderable
      ? [
          { token: "←", action: "take-previous" as const },
          { token: "→", action: "take-next" as const }
        ]
      : []),
    { token: "esc back", action: "cancel" as const }
  ];
  const compactActions = [
    { token: "↑", action: "focus-previous" as const },
    { token: "↓", action: "focus-next" as const },
    { token: "↵", action: "open-selected" as const },
    { token: "n", action: "new-item" as const },
    { token: "d", action: "delete-item" as const },
    ...(reorderable
      ? [
          { token: "←", action: "take-previous" as const },
          { token: "→", action: "take-next" as const }
        ]
      : []),
    { token: "esc", action: "cancel" as const }
  ];
  return footerFit([
    {
      text: reorderable
        ? "↑↓ move · ↵ edit · n add · d delete · ←→ reorder · esc back"
        : "↑↓ move · ↵ edit · n add · d delete · esc back",
      actions
    },
    {
      text: reorderable ? "↑↓ ↵ n d ←→ esc" : "↑↓ ↵ n d esc",
      actions: compactActions
    }
  ], width);
}

function footerFit(variants: SamplingFooter[], width: number): SamplingFooter {
  return variants.find((variant) => visibleWidth(variant.text) <= width) ?? variants.at(-1)!;
}
