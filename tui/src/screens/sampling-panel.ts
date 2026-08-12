import { composerPosition } from "../composer-model.js";
import type { HitRows, HitTarget } from "../hit.js";
import {
  boundedSamplingCursor,
  SAMPLING_LAYER_ROWS,
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
import { wrapFeedback } from "./feedback-wrap.js";
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
  const status = nested.result === null ? [] : samplingStatus(nested.result, contentWidth);
  const content = nested.panel === "sampling"
    ? renderSamplingLayer(settings, contentWidth, height, status)
    : renderSamplingListLayer(settings, contentWidth, height, status, nested.panel);
  const footer = samplingFooter(nested.panel, nested.edit !== null, horizontal.footerWidth);
  return placePanel(
    dimPage(base),
    nested.panel === "sampling" ? "sampling" : SAMPLING_LIST_RENDER_SPECS[nested.panel].title,
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
  const cursor = boundedSamplingCursor(settings);
  // One reason held by every knob is a fact about the provider, not about any
  // row. Repeated down the column it was the loudest thing on the panel and
  // pushed each row's own value out of alignment.
  const shared = sharedDisabledReason([...scalarByKnob.values()], [...listByPanel.values()]);
  const sharedLine: FrameLine[] = shared === null
    ? []
    : [[raisedSegment(truncate(`  ${shared}`, width), "prose · dim")]];
  // SAMPLING_LAYER_ROWS is the one ordering both the cursor and the paint use,
  // so a knob's place in the section list can never drift from its focus
  // stop. Each row's block is its section rule (if it opens a C-04 group)
  // followed by the row itself, so a section-leading row's two-line cost is
  // read off the block rather than kept as a second, index-aligned fact
  // beside it.
  const blocks = SAMPLING_LAYER_ROWS.map((spec, index) => {
    const row: SamplingLayerRow = spec.kind === "scalar"
      ? { kind: "scalar" as const, row: scalarByKnob.get(spec.knob)! }
      : { kind: "list" as const, row: listByPanel.get(spec.panel)! };
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
      rowId: samplingLayerRowIdentity(spec),
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
 * from this same panel's own `values()`, so the shape is already known.
 *
 * `title` lives here rather than in a second per-panel table (issue #282
 * review round 5, finding 7): `main` kept one table with `title` in it, and
 * this file had grown a second one keyed on the same
 * `SamplingListPanel` union before this fold. */
interface SamplingListRenderSpec {
  readonly title: string;
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
    title: "stop sequences",
    emptyCopy: [
      "  no stop sequences yet.",
      "  n writes one · the model stops when it types one"
    ],
    header: (count, maximum) => `  #   stop sequence · ${count}/${maximum}`,
    formatValue: (value, _settings, index, selected, width) =>
      listValueRow(index, value as string, selected, width)
  },
  "logit-bias": {
    title: "logit bias",
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
    title: "phrase bias",
    emptyCopy: [
      "  no phrase bias yet.",
      "  n writes one · phrase:integer bias · each phrase resolves to one or more tokens."
    ],
    header: (count, maximum) => `  phrase              bias  resolved tokens · ${count}/${maximum}`,
    formatValue: (value, settings, _index, selected, width) =>
      phraseBiasValueRow(value as SamplingPhraseBiasEntryV2, settings, selected, width)
  },
  "banned-strings": {
    title: "banned strings",
    emptyCopy: [
      "  no banned strings yet.",
      "  n writes one · a negative bias makes a string unlikely, not impossible."
    ],
    header: (count, maximum) => `  banned string             resolved tokens · ${count}/${maximum}`,
    formatValue: (value, settings, _index, selected, width) =>
      bannedStringValueRow(value as string, settings, selected, width)
  },
  "dry-breakers": {
    title: "dry breakers",
    emptyCopy: [
      "  no dry breakers yet.",
      // An empty list is not sent, and the provider then uses its own
      // breakers — so the empty state must not read as "dry has none".
      "  n writes one · until then the provider uses its own list"
    ],
    header: (count, maximum) => `  #   breaker · ${count}/${maximum}`,
    formatValue: (value, _settings, index, selected, width) =>
      listValueRow(index, value as string, selected, width)
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
  const values = modelSpec.values(settings);
  const cursor = boundedSamplingCursor(settings, panel);
  const activeEdit = settings.sampling?.edit;
  const pendingEdit = activeEdit?.kind === "list" && activeEdit.panel === panel && activeEdit.index === values.length
    ? activeEdit
    : null;
  // The header count comes from samplingListRows, not values.length directly
  // (issue #282 review round 2, finding 4): the logit-bias-family panels
  // display the shared resolved-token count there, which can run well ahead
  // of this panel's own raw entry count, and this header must agree with it
  // rather than repeating the same bug through a second code path.
  const row = samplingListRows(settings).find((item) => item.panel === panel)!;
  const header = [raisedSegment(truncate(renderSpec.header(row.count, row.maximum), width), "chrome")];
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

/** Decision 24's wrapping law, applied to the sampling panel's own status
 *  row. This clipped to one line, which is worst for the message that most
 *  needs reading: a rejected save states the reason in the tail, so a
 *  provider refusal arrived as a sentence cut mid-word with no way to see
 *  the rest. Continuation rows hang under the glyph, so the wrap measures
 *  against the room they actually get. */
const STATUS_ROW_CAP = 4;
const STATUS_HANGING_INDENT = 2;

function samplingStatus(text: string, width: number): FrameLine[] {
  const danger = text.includes("kept") || text.includes("disabled") || text.includes("limit");
  const role = danger ? "danger text" : "focus / accent";
  const wrapped = wrapFeedback(
    text, Math.max(8, width - 4 - STATUS_HANGING_INDENT), STATUS_ROW_CAP, "! full"
  );
  if (wrapped.rows.length === 0) return [];
  return wrapped.rows.map((row, index): FrameLine => [
    raisedSegment(
      truncate(index === 0 ? `  ${danger ? "▲" : "●"} ${row}` : `    ${row}`, width),
      role
    )
  ]);
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
