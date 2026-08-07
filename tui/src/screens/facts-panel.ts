import type { StoryPayload } from "../../../shared/types.js";
import {
  boundedFactSelection,
  factBody,
  factName,
  factPriorityGlyph,
  factRows,
  factStatusDisplay,
  factTags
} from "../facts-model.js";
import type { HitRegion, HitRows, HitTarget } from "../hit.js";
import type { KeyAction } from "../keys.js";
import type { RequestTokenEstimate } from "../request-projection.js";
import type { OverlayState } from "../state.js";
import {
  boundedContent,
  cellPad,
  factColumns,
  panelRange,
  panelRowWindow
} from "./panel-table-layout.js";
import {
  panelContentRows,
  panelHorizontalGeometry,
  placePanel,
  raisedSegment
} from "./overlay.js";
import {
  truncate,
  truncateTail,
  visibleWidth,
  TYPING_CARET,
  type FrameComposition,
  type FrameLine
} from "./story/frame.js";

export const FACTS_FOOTER_ACTIONS = [
  { token: "↑", action: "focus-previous" }, { token: "↓", action: "focus-next" },
  { token: "tab", action: "cycle" }, { token: "↵", action: "edit" },
  { token: "/ filter", action: "filter" }, { token: "e edit", action: "edit" },
  { token: "n new", action: "new-item" }, { token: "d", action: "delete-item" },
  { token: "esc", action: "cancel" }
] as const satisfies ReadonlyArray<{ token: string; action: KeyAction }>;

const FILTER_FOOTER_ACTIONS = [
  { token: "↵", action: "open-selected" },
  { token: "esc", action: "cancel" }
] as const satisfies ReadonlyArray<{ token: string; action: KeyAction }>;

export function renderFactsPanel(
  base: FrameLine[],
  state: OverlayState & { payload: StoryPayload; hitRows: HitRows },
  width: number,
  height: number,
  estimate: RequestTokenEstimate
): FrameComposition {
  const overlay = state.facts!;
  const tags = factTags(state.payload.facts);
  const selection = boundedFactSelection(state.payload.facts, overlay, overlay.query);
  const rows = factRows(state.payload.facts, selection.selectedTag, overlay.query);
  const keyedFacts = state.payload.facts.filter(({ activation }) => activation === "keyed");
  const activeKeyedCount = keyedFacts.filter(
    ({ id }) => estimate.factStatuses.get(id)?.kind === "sent"
  ).length;
  const unevaluatedCount = estimate.activation.unevaluated.length;
  const contentWidth = panelHorizontalGeometry(width).contentWidth;
  const columns = factColumns(contentWidth);
  const chipLines: FrameLine[] = [[raisedSegment("  tags  ", "chrome")]];
  const chipOverridesByLine: HitRegion[][] = [[]];
  let chipLeft = 8;
  for (const [index, tag] of tags.entries()) {
    const rendered = chip(
      truncate(tag ?? "all", Math.max(1, contentWidth - 12)),
      index === selection.chip
    );
    const chipWidth = visibleWidth(rendered.text);
    const gap = chipLeft > 8 ? 1 : 0;
    if (chipLeft > 8 && chipLeft + gap + chipWidth > contentWidth) {
      chipLines.push([raisedSegment("        ", "chrome")]);
      chipOverridesByLine.push([]);
      chipLeft = 8;
    }
    if (chipLeft > 8) {
      chipLines.at(-1)!.push(raisedSegment(" "));
      chipLeft += 1;
    }
    chipOverridesByLine.at(-1)!.push({
      target: { kind: "chip", index },
      left: chipLeft,
      right: chipLeft + chipWidth
    });
    chipLines.at(-1)!.push(rendered);
    chipLeft += chipWidth;
  }

  const content: FrameLine[] = [...chipLines];
  if (overlay.filtering || overlay.query.length > 0) {
    content.push(filterLine(overlay.query, contentWidth,
      `${rows.length} of ${state.payload.facts.length}`));
  }
  content.push([
    raisedSegment(cellPad("", columns.lead), "chrome"),
    raisedSegment(cellPad("name", columns.name), "chrome"),
    raisedSegment(cellPad("tag", columns.tag), "chrome"),
    raisedSegment(cellPad("note", columns.note), "chrome"),
    raisedSegment(cellPad(`status${unevaluatedCount === 0 ? "" : ` ⚠${unevaluatedCount}`}`, columns.status), "chrome")
  ]);
  const targets: Array<HitTarget | null> = content.map(() => null);
  const window = panelRowWindow(
    rows.map(() => 1),
    selection.cursor,
    panelContentRows(height) - content.length
  );
  for (let index = window.start; index < window.end; index += 1) {
    const fact = rows[index]!;
    const body = factBody(fact);
    const selected = index === selection.cursor;
    const requestStatus = estimate.factStatuses.get(fact.id) ?? { kind: "not-matched" as const };
    const display = factStatusDisplay(fact.activation, requestStatus, estimate.activation.traces.get(fact.id));
    const statusBase = display.glyph.length === 0 ? display.word : `${display.glyph} ${display.word}`;
    const priorityChar = factPriorityGlyph(fact.priority);
    // A blank glyph for "normal" priority keeps the column at its established
    // width for the common case; low/high only cost one more cell.
    const status = priorityChar.length === 0 ? statusBase : `${statusBase} ${priorityChar}`;
    content.push([
      raisedSegment(cellPad(selected ? "  ▸ " : "", columns.lead),
        selected ? "focus / accent" : "chrome"),
      raisedSegment(cellPad(truncate(factName(fact), Math.max(0, columns.name - 1)), columns.name),
        selected ? "prose" : "prose · dim"),
      raisedSegment(cellPad(truncate(fact.tag ?? "—", Math.max(0, columns.tag - 1)), columns.tag),
        "accent · deep"),
      raisedSegment(cellPad(body.length > 0 ? body : "—", columns.note), "chrome"),
      raisedSegment(cellPad(status, columns.status), display.emphasis)
    ]);
    targets.push({ kind: "list", index });
  }
  if (rows.length === 0) {
    // C-27: an empty state names the key that fixes it. An unfiltered store
    // with nothing in it is a different sentence from a filter that matched
    // nothing, and `no matching facts` used to be printed for both.
    content.push([raisedSegment(
      `  ${factsEmptyState(overlay.query, overlay.filtering, state.payload.facts.length)}`,
      "prose · dim")]);
    targets.push(null);
  }

  const footer = overlay.filtering
    ? "↵ done · esc done"
    : overlay.deleteArmedId === null
      ? width < 100
        ? "↑↓ · tab · ↵ edit · / filter · e edit · n new · d delete · esc"
        : "↑↓ · ⇧↑↓ move · tab tags · ↵ edit · / filter · e edit · n new · d delete · esc"
      : width < 100
        ? "↑↓ · tab · ↵ · / filter · e edit · n new · d confirms · esc keeps"
        : "↑↓ · ⇧↑↓ move · tab tags · ↵ edit · / filter · e edit · n new · d confirms · esc keeps";
  const activationCount = keyedFacts.length === 0
    ? ""
    : ` · ${activeKeyedCount}/${keyedFacts.length} keyed`;
  const exhaustionNotice = unevaluatedCount === 0 ? "" : ` · ⚠${unevaluatedCount} unchecked`;
  const title = `facts · ${state.payload.facts.length} notes${activationCount}${exhaustionNotice}`
    + panelRange(rows.length, window);
  return placePanel(
    base,
    title,
    boundedContent(content, contentWidth),
    footer,
    width,
    height,
    106,
    {
      rows: state.hitRows,
      targets,
      overrides: chipOverridesByLine,
      footerActions: overlay.filtering
        ? FILTER_FOOTER_ACTIONS
        : FACTS_FOOTER_ACTIONS
    }
  );
}

/** C-17: the filter always states `n of m`, so a short list is never mistaken
 *  for a short store. */
function filterLine(value: string, width: number, count: string): FrameLine {
  const prefix = truncate("  › filter: ", Math.max(0, width - 1));
  const suffix = `  ${count}`;
  const valueWidth = Math.max(0, width - visibleWidth(prefix) - visibleWidth(suffix) - 1);
  return [
    raisedSegment(prefix, "accent · deep"),
    raisedSegment(truncateTail(value, valueWidth), "streaming"),
    raisedSegment(TYPING_CARET, "focus / accent"),
    raisedSegment(suffix, "chrome")
  ];
}

function factsEmptyState(query: string, filtering: boolean, total: number): string {
  if (total === 0) return "no facts yet · n writes one";
  // A committed filter still narrows the list, but the editor that backspace
  // belongs to is closed — `/` is what reopens it.
  if (query.length > 0) {
    return filtering
      ? "no fact matches · backspace widens the filter"
      : "no fact matches · / reopens the filter";
  }
  return "no facts under this tag · tab picks another";
}

function chip(label: string, active: boolean) {
  return active
    ? {
        text: `[ ${label} ]`,
        role: "background" as const,
        background: "accent · deep" as const,
        bold: true
      }
    : raisedSegment(`[ ${label} ]`, "chrome");
}
