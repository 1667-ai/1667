import { composerPosition } from "../composer-model.js";
import type { HitRows, HitTarget } from "../hit.js";
import {
  boundedSamplingCursor,
  SAMPLING_LAYER_ROWS,
  samplingLayerRowIdentity,
  type SamplingScalarRow,
  samplingListRows,
  samplingScalarRows
} from "../sampling-model.js";
import {
  samplingListItemIdentity,
  samplingListPanelInfo,
  samplingListValues,
  type SamplingListPanelId,
  type SamplingListRow,
  type SamplingListValue
} from "../sampling-list-model.js";
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
    nested.panel === "sampling" ? "sampling" : samplingListPanelInfo(nested.panel).title,
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
  const scalarByKnob = new Map(samplingScalarRows(settings).map((row) => [row.knob, row] as const));
  const listByPanel = new Map(samplingListRows(settings).map((row) => [row.panel, row] as const));
  // SAMPLING_LAYER_ROWS is the one ordering both the cursor and the paint use,
  // so a knob's place in the section list can never drift from its focus stop.
  const rows: SamplingLayerRow[] = SAMPLING_LAYER_ROWS.map((spec) =>
    spec.kind === "scalar"
      ? { kind: "scalar" as const, row: scalarByKnob.get(spec.knob)! }
      : { kind: "list" as const, row: listByPanel.get(spec.panel)! }
  );
  const cursor = boundedSamplingCursor(settings);
  // One reason held by every knob is a fact about the provider, not about any
  // row. Repeated down the column it was the loudest thing on the panel and
  // pushed each row's own value out of alignment.
  const shared = sharedDisabledReason(
    [...scalarByKnob.values()],
    [...listByPanel.values()]
  );
  const sharedLine: FrameLine[] = shared === null
    ? []
    : [[raisedSegment(truncate(`  ${shared}`, width), "prose · dim")]];
  // Each row's block is its section rule (if it opens a C-04 group) followed
  // by the row itself, so a section-leading row's two-line cost is read off
  // the block rather than kept as a second, index-aligned fact beside it.
  const blocks = SAMPLING_LAYER_ROWS.map((spec, index) => {
    const row = rows[index]!;
    const lines: FrameLine[] = [];
    const targets: Array<HitTarget | null> = [];
    if (spec.section !== undefined) {
      lines.push(samplingSectionRule(spec.section, width));
      targets.push(null);
    }
    lines.push(renderSamplingRow(row, index === cursor, settings, width, shared !== null));
    targets.push({
      kind: "list",
      index,
      rowId: row.kind === "scalar"
        ? samplingLayerRowIdentity({ kind: "scalar", knob: row.row.knob })
        : samplingLayerRowIdentity({ kind: "list", panel: row.row.panel }),
      selected: index === cursor
    });
    return { lines, targets };
  });
  const capacity = Math.max(1,
    panelContentRows(height) - status.length - sharedLine.length);
  const window = panelRowWindow(blocks.map((block) => block.lines.length), cursor, capacity);
  const lines: FrameLine[] = [...status, ...sharedLine];
  const targets: Array<HitTarget | null> = [
    ...status.map(() => null),
    ...sharedLine.map(() => null)
  ];
  for (const block of blocks.slice(window.start, window.end)) {
    lines.push(...block.lines);
    targets.push(...block.targets);
  }
  return { lines, targets };
}

/** C-04's rule: `── <title> ` padded with `─` to the content width, in the
 *  `chrome` role, truncated rather than wrapped on a narrow panel. */
function samplingSectionRule(title: string, width: number): FrameLine {
  const rule = `── ${title} `;
  const fill = width - visibleWidth(rule);
  return [raisedSegment(
    fill > 0 ? `${rule}${"─".repeat(fill)}` : truncate(rule, width),
    "chrome"
  )];
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
      row.row.available ? row.row.hint : reasonShared ? "" : row.row.reason,
      width,
      selected,
      row.row.available ? "chrome" : "prose · dim"
    );
  }
  return fieldRow(
    lead,
    row.row.label,
    `[${row.row.value}]`,
    row.row.available ? "↵ open" : reasonShared ? "" : `disabled · ${row.row.reasonCompact}`,
    width,
    selected,
    row.row.available ? "chrome" : "prose · dim"
  );
}

function renderSamplingListLayer(
  settings: NonNullable<OverlayState["settings"]>,
  width: number,
  height: number,
  status: FrameLine[],
  panel: SamplingListPanelId
): { lines: FrameLine[]; targets: Array<HitTarget | null> } {
  const info = samplingListPanelInfo(panel);
  const values = samplingListValues(settings, panel);
  const cursor = boundedSamplingCursor(settings, panel);
  const activeEdit = settings.sampling?.edit;
  const pendingEdit = activeEdit?.kind === panel && activeEdit.index === values.length
    ? activeEdit
    : null;
  const header = [raisedSegment(truncate(samplingListHeader(info, values.length), width), "chrome")];
  const rows: FrameLine[] = [];
  const targets: Array<HitTarget | null> = [...status.map(() => null), null];
  if (values.length === 0) {
    for (const text of info.emptyCopy) {
      rows.push([raisedSegment(truncate(text, width), "prose · dim")]);
      targets.push(null);
    }
  }
  const rowCount = values.length + (pendingEdit === null ? 0 : 1);
  if (rowCount > 0) {
    const emptyCopyRows = values.length === 0 ? info.emptyCopy.length : 0;
    const capacity = Math.max(1, panelContentRows(height) - status.length - 1 - emptyCopyRows);
    const window = panelRowWindow(Array.from({ length: rowCount }, () => 1), cursor, capacity);
    for (let index = window.start; index < window.end; index += 1) {
      if (index === values.length && pendingEdit !== null) {
        rows.push(inlineListValueRow(index, pendingEdit.composer, width));
      } else {
        const value = values[index];
        if (value === undefined) continue;
        const edit = index === cursor && activeEdit?.kind === panel
          ? activeEdit
          : null;
        rows.push(edit === null
          ? samplingListFormatValue(info, value, index, cursor === index, width)
          : inlineListValueRow(index, edit.composer, width));
      }
      const rowId = samplingListItemIdentity(
        panel,
        index === values.length ? undefined : values[index],
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

/** The header differs only by kind: a plain-string list numbers its rows, a
 *  record list names its two columns. `dry-breakers` shares `stop`'s branch
 *  automatically — no panel-specific case was added for it. */
function samplingListHeader(info: ReturnType<typeof samplingListPanelInfo>, count: number): string {
  return info.kind === "record"
    ? `  token ID       integer bias · ${count}/${info.maximum}`
    : `  #   ${info.itemLabel} · ${count}/${info.maximum}`;
}

function samplingListFormatValue(
  info: ReturnType<typeof samplingListPanelInfo>,
  value: SamplingListValue,
  index: number,
  selected: boolean,
  width: number
): FrameLine {
  if (info.kind === "record") {
    if (typeof value === "string") throw new Error(`${info.panel} row has an invalid value`);
    return logitValueRow(value[0], value[1], selected, width);
  }
  if (typeof value !== "string") throw new Error(`${info.panel} row has an invalid value`);
  return listValueRow(index, value, selected, width);
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
  panel: "sampling" | SamplingListPanelId,
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
  // `dry-breakers` reorders exactly like `stop` — both read `reorderable` off
  // the same table, so neither footer variant branches on the panel id.
  const reorderable = samplingListPanelInfo(panel).reorderable;
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
