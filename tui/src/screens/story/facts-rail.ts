import { addHit, type HitRows } from "../../hit.js";
import type { FrameDeadlineCollector } from "../../animation-deadline.js";
import { factPriorityGlyph, factStatusDisplay } from "../../facts-model.js";
import { RAIL_CONTENT_WIDTH, type RailModel } from "../../rail.js";
import type { StoryFrameLayout } from "../../story-frame-layout.js";
import { wrapText } from "../../wrap.js";
import { contextMeterLines } from "./context-meter.js";
import { fitLine, segment, truncate, visibleWidth, type FrameLine } from "./frame.js";

/** Rule, request, gauge — the meter's own floor, below which it shows less. */
const COLLAPSED_METER_ROWS = 3;

/** Append the read-only facts rail and register every fact row as a target.
 *
 * `surfaceRows` is the split surface only — the status bar spans the whole
 * terminal beneath it and is composed by the caller, so the separator never
 * runs down through it. */
export function renderFactsRail(
  lines: FrameLine[],
  model: RailModel,
  hits: HitRows,
  surfaceRows: number,
  layout: StoryFrameLayout,
  expanded = false,
  now = 0,
  deadlines?: FrameDeadlineCollector,
  growthPulse = true
): FrameLine[] {
  if (layout.factLeft === null) throw new Error("facts rail requires split frame layout");
  const factLeft = layout.factLeft;
  const railRight = layout.railRight ?? layout.fullWidth;
  const rows: FrameLine[] = [railHeader(model), []];
  const targets: Array<number | null> = [null, null];
  for (const fact of model.facts) {
    const tag = truncate(fact.tag, Math.max(0, RAIL_CONTENT_WIDTH - 3));
    const tagWidth = visibleWidth(tag);
    const tagGap = tagWidth > 0 ? 1 : 0;
    const name = truncate(fact.name, Math.max(0, RAIL_CONTENT_WIDTH - 2 - tagGap - tagWidth));
    // Two one-cell glyphs share the marker's fixed two-cell budget: request
    // status first, then priority — blank for the common cases (an `always`
    // Fact riding whole, a "normal" priority), so a state worth noticing is
    // the only thing that ever draws there.
    const requestStatus = factStatusDisplay(fact.activation, fact.status, fact.trace);
    const activationGlyph = requestStatus.glyph.length === 0
      ? segment(" ")
      : segment(requestStatus.glyph, requestStatus.emphasis);
    const priorityChar = factPriorityGlyph(fact.priority);
    const priorityGlyph = priorityChar.length === 0
      ? segment(" ")
      : segment(priorityChar, fact.priority === "low" ? "prose · dim" : "chrome");
    const namePart = [
      activationGlyph,
      priorityGlyph,
      segment(name, fact.status.kind === "sent" ? "prose" : "prose · dim")
    ];
    const gap = Math.max(tagGap, RAIL_CONTENT_WIDTH - 2 - visibleWidth(name) - tagWidth);
    rows.push([...namePart,
      segment(" ".repeat(gap)),
      segment(tag, "brass dim")]);
    targets.push(fact.index);
    if (fact.activation === "keyed" && fact.status.kind === "sent" && fact.body.length > 0) {
      for (const line of wrapText(fact.body, [], RAIL_CONTENT_WIDTH - 4).slice(0, 4)) {
        rows.push([segment("    "), { ...segment(line.text, "prose · dim"), prose: true }]);
        targets.push(fact.index);
      }
    }
    rows.push([]);
    targets.push(null);
  }
  // The loop leaves one decorative blank after the last block, but the frame's
  // padding already provides that air. Drop it so the clip guard below fires
  // only when content was actually cut, never on an exact fit.
  rows.pop();
  targets.pop();
  // The rail is facts *and* meter. The last row is always air; above it the
  // rail keeps the row that names it and, where there are facts, room for one
  // of them with its air — so the expansion waits for a pane that can hold both
  // surfaces instead of taking every row the moment it technically fits. A rail
  // too short for even that still gets the whole collapsed meter, which is what
  // keeps the budget from shrinking as the pane grows.
  const reserve = model.facts.length > 0 ? 4 : 2;
  const budget = Math.max(0, surfaceRows - reserve, Math.min(surfaceRows, COLLAPSED_METER_ROWS));
  const footer = contextMeterLines(model, expanded, budget, now, deadlines, growthPulse);
  const footerTop = surfaceRows - footer.length;
  // The facts own every row above the footer. One of those is normally left as
  // air under the last fact — but a rail short enough that the air would cost
  // the header spends it on facts instead.
  const body = rows.slice(0, footerTop > 1 ? footerTop - 1 : Math.max(0, footerTop));
  const rail: FrameLine[] = Array.from({ length: surfaceRows }, () => []);
  body.forEach((line, row) => {
    rail[row] = line;
    const index = targets[row] ?? null;
    if (index !== null) addHit(hits, row, {
      target: { kind: "fact", index }, left: factLeft, right: railRight
    });
  });
  // A clipped list says so. The slice already reserves one air row between
  // the facts and the meter; when facts were cut, that row names the count
  // instead of staying air. No visible fact is traded for it, it registers
  // no hit, and it can never displace the header — the reserved row sits at
  // footerTop - 1, which the footerTop > 1 guard keeps below row 0.
  if (body.length < rows.length && footerTop > 1) {
    const shown = new Set(
      body.map((_, row) => targets[row]).filter((target) => target !== null)
    ).size;
    const hidden = model.facts.length - shown;
    if (hidden > 0) {
      rail[body.length] = [segment("  "), segment(`· ${hidden} more`, "chrome")];
    }
  }
  // The column's own name opens the panel it names — the rail is read-only, so
  // without this its header is the one row in the frame that looks like a
  // control and answers nothing.
  if (body.length > 0) {
    addHit(hits, 0, { target: { kind: "action", action: "open-facts" }, left: factLeft, right: railRight });
  }
  footer.forEach((line, offset) => {
    rail[footerTop + offset] = line;
    addHit(hits, footerTop + offset, {
      target: { kind: "action", action: "toggle-context-meter" }, left: factLeft, right: railRight
    });
  });
  return rail.map((railLine, row) =>
    fitLine([...lines[row] ?? [], segment("│", "dimmed page"), segment(" "), ...railLine], layout.fullWidth));
}

/** The rail names itself and reports keyed activation for the next request. */
function railHeader(model: RailModel): FrameLine {
  const name = "facts";
  const keyed = model.keyedFactCount === 0
    ? ""
    : ` · ${model.activeKeyedCount}/${model.keyedFactCount} keyed`;
  const label = ` · ${model.factCount}${keyed} `;
  const fill = Math.max(1,
    RAIL_CONTENT_WIDTH - visibleWidth(name) - visibleWidth(label));
  return [
    segment(name, "focus / accent"),
    segment(label, "chrome"),
    segment("─".repeat(fill), "dimmed page")
  ];
}
