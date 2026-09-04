import type { StoryPayload } from "../../../shared/types.js";
import { wrapText } from "../wrap.js";
import {
  factConsistencyFindingStatus,
  factConsistencyScopeLabel,
  type FactConsistencyFinding,
  type FactConsistencyRun
} from "../fact-consistency-check.js";
import type { FactConsistencySurface } from "../fact-consistency-actions.js";
import {
  boundedContent,
  panelRowWindow
} from "./panel-table-layout.js";
import {
  dimPage,
  panelContentRows,
  panelHorizontalGeometry,
  placePanel,
  raisedSegment
} from "./overlay.js";
import {
  truncate,
  visibleWidth,
  type FrameComposition,
  type FrameLine
} from "./story/frame.js";

const MIN_FINDING_LIST_ROWS = 3;

export interface FactConsistencyPanelOptions {
  readonly width: number;
  readonly height: number;
}

/** Render the isolated Fact consistency surface. The caller owns app state;
 * this module only paints the preflight, latest run, and selected detail. */
export function renderFactConsistencyPanel(
  base: FrameLine[],
  surface: FactConsistencySurface,
  payload: StoryPayload,
  options: FactConsistencyPanelOptions
): FrameComposition {
  const { width, height } = options;
  const horizontal = panelHorizontalGeometry(width);
  const contentWidth = horizontal.contentWidth;
  const content = surface.phase === "confirm"
    ? confirmationContent(surface, contentWidth)
    : surface.phase === "running"
      ? runningContent(surface, contentWidth)
      : resultsContent(surface, payload, contentWidth, height);
  const footer = surface.phase === "confirm"
    ? surface.preflight.eligiblePartCount === 0
      ? "esc cancel"
      : surface.failure === undefined ? "↵ check · esc cancel" : "↵ plan again · esc cancel"
    : surface.phase === "running"
      ? "esc close"
      : findingFooter(surface, payload);
  const titleBase = `fact consistency · ${factConsistencyScopeLabel(surface.preflight.scope)}`;
  const title = surface.phase !== "results"
    ? titleBase
    : visibleWidth(`${titleBase} · ${findingCountLabel(surface.run.findings.length)}`)
      <= horizontal.titleWidth
      ? `${titleBase} · ${findingCountLabel(surface.run.findings.length)}`
      : titleBase;
  return placePanel(
    dimPage(base),
    title,
    boundedContent(content, contentWidth),
    footer,
    width,
    height,
    106
  );
}

function confirmationContent(
  surface: Extract<FactConsistencySurface, { phase: "confirm" }>,
  width: number
): FrameLine[] {
  const { preflight } = surface;
  const scope = factConsistencyScopeLabel(preflight.scope);
  const skipped = preflight.skippedPartCount === 0
    ? ""
    : ` · ${preflight.skippedPartCount} skipped (no applicable Fact State)`;
  const requests = preflight.requestCountExact !== true || preflight.requestCount === undefined
    ? ""
    : ` · ${quantityLabel(preflight.requestCount, "model request")}`;
  return [
    ...(surface.failure === undefined
      ? []
      : [
          [raisedSegment("  Fact consistency failed", "context warning")],
          ...wrapLabel(`  ${surface.failure}`, width)
        ]),
    [raisedSegment(`  check ${scope} against Facts`, "context facts")],
    ...wrapLabel(
      `  ${quantityLabel(preflight.eligiblePartCount, "eligible part")}${requests}${skipped}`,
      width,
      "prose"
    ),
    [raisedSegment("  read-only · no prose changes", "chrome")],
    ...(preflight.scope === "line"
      ? [[raisedSegment("  larger checks can take time · runs in background", "chrome")]]
      : []),
    ...(preflight.eligiblePartCount === 0
      ? [[raisedSegment("  nothing to check", "context warning")]]
      : wrapLabel("  press Enter to check · Escape to cancel", width))
  ];
}

function runningContent(
  surface: Extract<FactConsistencySurface, { phase: "running" }>,
  width: number
): FrameLine[] {
  const scope = factConsistencyScopeLabel(surface.preflight.scope);
  return [
    [raisedSegment(`  checking ${scope} against Facts…`, "context facts")],
    [raisedSegment(`  ${surface.preflight.eligiblePartCount} parts · requests in progress`, "prose")],
    ...wrapLabel("  Escape closes this view; the read-only run will settle safely", width)
  ];
}

function resultsContent(
  surface: Extract<FactConsistencySurface, { phase: "results" }>,
  payload: StoryPayload,
  width: number,
  height: number
): FrameLine[] {
  const findings = surface.run.findings;
  const detail = selectedDetail(findings[surface.cursor] ?? null, payload, width);
  const contentRows = panelContentRows(height);
  if (findings.length === 0) {
    const unchecked = surface.run.uncheckedParts.length;
    const headline = surface.run.checkedParts.length === 0 && unchecked > 0
      ? `  ⚠ ${unchecked} unchecked · none checked`
      : "  no contradictions found";
    const summary = [
      [raisedSegment(headline, unchecked > 0 ? "context warning" : "context facts")],
      [raisedSegment(
        `  checked ${surface.run.checkedParts.length} parts · ${surface.run.rejectedCount} rejected`
          + ` · ${unchecked} unchecked`,
        "chrome"
      )]
    ] satisfies FrameLine[];
    return [
      ...summary,
      ...uncheckedContent(
        surface.run.uncheckedParts,
        width,
        Math.max(0, contentRows - summary.length)
      ),
      ...detail
    ];
  }
  const detailRows = [
    [raisedSegment("  selected finding", "chrome")],
    ...detail
  ];
  const uncheckedRows = uncheckedContent(
    surface.run.uncheckedParts,
    width,
    // Keep enough of the findings list to make selection useful on a short
    // terminal. The count and overflow marker still fit when unchecked parts
    // outnumber the space left for their detail rows.
    Math.max(
      surface.run.uncheckedParts.length > 0 ? 1 : 0,
      contentRows - detailRows.length - 1 - MIN_FINDING_LIST_ROWS
    )
  );
  const listBudget = Math.max(1, contentRows - detailRows.length - uncheckedRows.length - 1);
  const window = panelRowWindow(findings.map(() => 1), surface.cursor, listBudget);
  const list: FrameLine[] = [
    [raisedSegment(
      `  findings · ${window.start + 1}–${window.end}/${findings.length}`
        + ` · ${surface.run.rejectedCount} rejected`,
      "chrome"
    )]
  ];
  for (let index = window.start; index < window.end; index += 1) {
    const finding = findings[index]!;
    list.push(findingListLine(finding, index === surface.cursor, payload, width));
  }
  return [...list, ...detailRows, ...uncheckedRows];
}

function uncheckedContent(
  parts: FactConsistencyRun["uncheckedParts"],
  width: number,
  maxRows: number
): FrameLine[] {
  if (parts.length === 0 || maxRows <= 0) return [];
  const available = Math.max(0, maxRows - 1);
  const reserveOverflow = parts.length > available ? 1 : 0;
  let remaining = Math.max(0, available - reserveOverflow);
  const rows: FrameLine[] = [];
  let shownCount = 0;
  for (const part of parts) {
    if (remaining <= 0) break;
    const partRows = uncheckedPartRows(part, width, Math.min(2, remaining));
    if (partRows.length === 0) continue;
    rows.push(...partRows);
    remaining -= partRows.length;
    shownCount += 1;
  }
  const hidden = parts.length - shownCount;
  return [
    [raisedSegment(`  unchecked parts · ${parts.length}`, "context warning")],
    ...rows,
    ...(hidden > 0 && reserveOverflow > 0
      ? [[raisedSegment(
          truncate(`  … ${hidden} unchecked ${hidden === 1 ? "part" : "parts"} not shown`, Math.max(0, width)),
          "context warning"
        )]] satisfies FrameLine[]
      : [])
  ];
}

function uncheckedPartRows(
  part: FactConsistencyRun["uncheckedParts"][number],
  width: number,
  maxRows: number
): FrameLine[] {
  const label = `  ! story part ${part.lineIndex < 0 ? "?" : part.lineIndex + 1} · `;
  const prefixWidth = visibleWidth(label);
  const wrapped = wrapText(
    part.reason,
    [],
    Math.max(1, width - prefixWidth)
  );
  const clipped = wrapped.slice(0, Math.max(1, maxRows));
  if (wrapped.length > clipped.length && clipped.length > 0) {
    const last = clipped[clipped.length - 1]!;
    clipped[clipped.length - 1] = { ...last, text: `${last.text.trimEnd()}…` };
  }
  return clipped.map((line, index) => [raisedSegment(
    `${index === 0 ? label : " ".repeat(prefixWidth)}${line.text}`,
    "context warning"
  )]);
}

function findingListLine(
  finding: FactConsistencyFinding,
  selected: boolean,
  payload: StoryPayload,
  width: number
): FrameLine {
  const status = factConsistencyFindingStatus(payload, finding);
  const stale = status === "stale";
  const marker = selected ? "▸ " : "  ";
  const statusLabel = status === "stale" ? " [stale]"
    : status === "off-line" ? " [off line]"
      : "";
  const value = `${finding.factName}${statusLabel} · “${finding.quote}”`;
  return [raisedSegment(
    truncate(`  ${marker}${value}`, Math.max(0, width)),
    selected ? "focus / accent" : stale ? "context warning" : "prose"
  )];
}

function selectedDetail(
  finding: FactConsistencyFinding | null,
  payload: StoryPayload,
  width: number
): FrameLine[] {
  if (finding === null) return [];
  const status = factConsistencyFindingStatus(payload, finding);
  const stale = status === "stale";
  const statusLabel = status === "stale" ? " [stale]"
    : status === "off-line" ? " [off line]"
      : "";
  return [
    [raisedSegment(`  Fact Name: ${finding.factName}${statusLabel}`, stale ? "context warning" : "context facts")],
    ...wrapField("  exact quote: ", finding.quote, width, 3),
    ...wrapField(
      "  contradiction: ",
      finding.statement.replace(/\s+/g, " ").trim(),
      width,
      3
    )
  ];
}

function findingFooter(
  surface: Extract<FactConsistencySurface, { phase: "results" }>,
  payload: StoryPayload
): string {
  const selected = surface.run.findings[surface.cursor];
  if (selected === undefined) return "esc close";
  const status = factConsistencyFindingStatus(payload, selected);
  const open = status === "stale"
    ? "↵ stale"
    : status === "off-line"
      ? "↵ view in MAP"
      : "↵ focus part";
  return ["↑↓ select", open, "f open Fact", "esc close"].join(" · ");
}

function findingCountLabel(count: number): string {
  return `${count} finding${count === 1 ? "" : "s"}`;
}

function quantityLabel(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

function wrapField(label: string, value: string, width: number, maxRows?: number): FrameLine[] {
  const prefixWidth = visibleWidth(label);
  const wrapped = wrapText(value.length === 0 ? "—" : value, [], Math.max(1, width - prefixWidth));
  const clipped = maxRows === undefined ? wrapped : wrapped.slice(0, maxRows);
  if (maxRows !== undefined && wrapped.length > clipped.length && clipped.length > 0) {
    const last = clipped[clipped.length - 1]!;
    clipped[clipped.length - 1] = { ...last, text: `${last.text.trimEnd()}…` };
  }
  return clipped.map((line, index) => [raisedSegment(
    `${index === 0 ? label : " ".repeat(prefixWidth)}${line.text}`,
    "prose"
  )]);
}

function wrapLabel(value: string, width: number, role: "chrome" | "prose" = "chrome"): FrameLine[] {
  const indent = value.match(/^ */u)?.[0] ?? "";
  return wrapText(value.slice(indent.length), [], Math.max(1, width - visibleWidth(indent)))
    .map((line) => [raisedSegment(`${indent}${line.text}`, role)]);
}
