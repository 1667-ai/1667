import { composerPosition } from "../composer-model.js";
import type { HitRows, HitTarget } from "../hit.js";
import {
  boundedSamplingCursor,
  SAMPLING_LAYER_ROWS,
  samplingLogitBiasEntries,
  type SamplingListRow,
  type SamplingScalarRow,
  samplingListRows,
  samplingScalarRows
} from "../sampling-model.js";
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
import { truncate, visibleWidth, type FrameComposition, type FrameLine } from "./story/frame.js";

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
    : nested.panel === "stop"
      ? renderStopLayer(settings, contentWidth, height, status)
      : renderLogitBiasLayer(settings, contentWidth, height, status);
  const footer = samplingFooter(nested.panel, nested.edit !== null, horizontal.footerWidth);
  return placePanel(
    dimPage(base),
    nested.panel === "sampling" ? "sampling" : nested.panel === "stop" ? "stop sequences" : "logit bias",
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
  const capacity = Math.max(1, panelContentRows(height) - status.length);
  const window = panelRowWindow(rows.map(() => 1), cursor, capacity);
  const lines: FrameLine[] = [...status];
  const targets: Array<HitTarget | null> = status.map(() => null);
  for (const [offset, row] of rows.slice(window.start, window.end).entries()) {
    const index = window.start + offset;
    lines.push(renderSamplingRow(row, index === cursor, settings, width));
    targets.push({ kind: "list", index, selected: index === cursor });
  }
  return { lines, targets };
}

function renderSamplingRow(
  row: SamplingLayerRow,
  selected: boolean,
  settings: NonNullable<OverlayState["settings"]>,
  width: number
): FrameLine {
  const lead = selected ? "  ▸ " : "    ";
  if (row.kind === "scalar") {
    const edit = selected && settings.sampling?.edit?.kind === "scalar"
      ? settings.sampling.edit
      : null;
    const value = row.row.available ? `‹ ${row.row.value} ›` : "‹ — ›";
    const reason = row.row.available ? "" : ` · ${row.row.reason}`;
    if (edit !== null) {
      return inlineRow(lead, row.row.label, edit.composer, width);
    }
    return plainRow(`${lead}${row.row.label}`, `${value}${reason}`, width, selected);
  }
  return plainRow(
    `${lead}${row.row.label}`,
    row.row.available
      ? `[${row.row.value}] · ↵ open`
      : `[${row.row.value}] · [disabled · ${row.row.reasonCompact}]`,
    width,
    selected
  );
}

function renderStopLayer(
  settings: NonNullable<OverlayState["settings"]>,
  width: number,
  height: number,
  status: FrameLine[]
): { lines: FrameLine[]; targets: Array<HitTarget | null> } {
  const stopSummary = samplingListRows(settings)[0]!;
  const values = settings.draft.sampling.stop;
  const cursor = boundedSamplingCursor(settings, "stop");
  const header = [raisedSegment(truncate(`  #   stop sequence · ${values.length}/${stopSummary.maximum}`, width), "chrome")];
  const rows: FrameLine[] = [];
  const targets: Array<HitTarget | null> = [...status.map(() => null), null];
  if (values.length === 0) {
    rows.push([raisedSegment(truncate("  no stop sequences yet.", width), "prose · dim")]);
    rows.push([raisedSegment(truncate("  n writes one · the model stops when it types one", width), "prose · dim")]);
    targets.push(null);
    targets.push(null);
  } else {
    const capacity = Math.max(1, panelContentRows(height) - status.length - 1);
    const window = panelRowWindow(values.map(() => 1), cursor, capacity);
    for (const [offset, value] of values.slice(window.start, window.end).entries()) {
      const index = window.start + offset;
      const edit = index === cursor && settings.sampling?.edit?.kind === "stop"
        ? settings.sampling.edit
        : null;
      rows.push(edit === null
        ? listValueRow(index, value, cursor === index, width)
        : inlineListValueRow(index, edit.composer, width));
      targets.push({ kind: "list", index, selected: index === cursor });
    }
  }
  return { lines: [...status, header, ...rows], targets };
}

function renderLogitBiasLayer(
  settings: NonNullable<OverlayState["settings"]>,
  width: number,
  height: number,
  status: FrameLine[]
): { lines: FrameLine[]; targets: Array<HitTarget | null> } {
  const logitSummary = samplingListRows(settings)[1]!;
  const values = samplingLogitBiasEntries(settings);
  const cursor = boundedSamplingCursor(settings, "logit-bias");
  const headerText = `  token ID       integer bias · ${values.length}/${logitSummary.maximum}`;
  const header = [raisedSegment(truncate(headerText, width), "chrome")];
  const rows: FrameLine[] = [];
  const targets: Array<HitTarget | null> = [...status.map(() => null), null];
  if (values.length === 0) {
    rows.push([raisedSegment(truncate("  no biased tokens yet.", width), "prose · dim")]);
    rows.push([raisedSegment(truncate("  n writes one · token IDs come from the model's tokenizer.", width), "prose · dim")]);
    targets.push(null);
    targets.push(null);
  } else {
    const capacity = Math.max(1, panelContentRows(height) - status.length - 1);
    const window = panelRowWindow(values.map(() => 1), cursor, capacity);
    for (const [offset, [token, weight]] of values.slice(window.start, window.end).entries()) {
      const index = window.start + offset;
      const edit = index === cursor && settings.sampling?.edit?.kind === "logit-bias"
        ? settings.sampling.edit
        : null;
      rows.push(edit === null
        ? logitValueRow(token, weight, cursor === index, width)
        : inlineListValueRow(index, edit.composer, width));
      targets.push({ kind: "list", index, selected: index === cursor });
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

function samplingFooter(panel: string, editing: boolean, width: number): SamplingFooter {
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
  return footerFit([
    { text: "↑↓ move · ↵ edit · n add · d delete · ←→ reorder · esc back", actions: [
      { token: "↑", action: "focus-previous" }, { token: "↓", action: "focus-next" },
      { token: "↵ edit", action: "open-selected" }, { token: "n add", action: "new-item" },
      { token: "d delete", action: "delete-item" }, { token: "←", action: "take-previous" },
      { token: "→", action: "take-next" }, { token: "esc back", action: "cancel" }
    ] },
    { text: "↑↓ ↵ n d ←→ esc", actions: [
      { token: "↑", action: "focus-previous" }, { token: "↓", action: "focus-next" },
      { token: "↵", action: "open-selected" }, { token: "n", action: "new-item" },
      { token: "d", action: "delete-item" }, { token: "←", action: "take-previous" },
      { token: "→", action: "take-next" }, { token: "esc", action: "cancel" }
    ] }
  ], width);
}

function footerFit(variants: SamplingFooter[], width: number): SamplingFooter {
  return variants.find((variant) => visibleWidth(variant.text) <= width) ?? variants.at(-1)!;
}
