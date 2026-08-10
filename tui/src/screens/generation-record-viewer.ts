import type { GenerationRecordSummary } from "../../../shared/generation-record.js";
import type { NodeStub } from "../../../shared/types.js";
import type { FrameDeadlineCollector } from "../animation-deadline.js";
import type { HitTarget } from "../hit.js";
import type { GenerationRecordDetailError, GenerationRecordViewerState, StoryScreenState } from "../state.js";
import { tagGlyph, tagRole } from "../tag-presentation.js";
import { renderConnectionBanner } from "./connection-banner.js";
import { renderSurfaceBreadcrumb } from "./surface-breadcrumb.js";
import {
  adjustmentNotices,
  generationRecordFieldText,
  generationRecordKindLabel,
  generationRecordOperationLabel,
  generationRecordPipelineRows,
  humanEditWarning,
  pipelineCharacterCount,
  visibleEntryCount,
  type GenerationRecordPipelineRow
} from "../generation-record-pipeline.js";
import {
  messageDocumentRows,
  noticeSection,
  renderRequestDocumentShell,
  titleRule,
  type RequestDocumentRow
} from "./request-document.js";
import { fitLine, segment, type FrameLine } from "./story/frame.js";

/** The Generation Record Viewer (RECORD mode): a read-only, archival history
 *  of every captured request that produced or changed one take. Connects to
 *  the story renderer's shell the same way `request-viewer.ts` does, and
 *  never builds or reads a `NextRequestEstimate` — a historical record
 *  describes a request that already happened, not the next one. */
export function renderGenerationRecordViewerScreen(
  state: StoryScreenState,
  recordState: GenerationRecordViewerState,
  width: number,
  height: number,
  deadlines?: FrameDeadlineCollector
) {
  const node = state.payload.nodes.find((candidate) => candidate.id === recordState.nodeId) ?? null;
  const summary = recordState.list.status === "ready" ? recordState.list.summaries[recordState.eventIndex] ?? null : null;
  const detailValue = recordState.detail.status === "ready" ? recordState.detail.detail : null;
  const entryIndex = Math.max(
    0,
    Math.min(Math.max(0, visibleEntryCount(detailValue) - 1), recordState.entryIndex)
  );
  const header = recordHeader(recordState, summary, width);
  const body = recordBody(recordState, node, entryIndex, width);
  const footer: FrameLine[] = [
    [segment("─".repeat(Math.max(0, width)), "chrome")],
    recordBreadcrumb(state, recordState, width)
  ];
  const shell = renderRequestDocumentShell({
    header,
    body: body.rows,
    footer,
    width,
    height,
    scrollTop: recordState.scrollTop,
    reveal: body.starts[entryIndex] ?? 0,
    revealAtStart: entryIndex === 0
  });
  const lines = state.connection.down
    ? renderConnectionBanner(shell.lines, { ...state, hitRows: shell.hitRows }, width, deadlines)
    : shell.lines;
  return {
    lines,
    selectable: null,
    derived: {
      hitRows: shell.hitRows,
      viewScroll: state.viewScroll,
      viewScrollDelta: state.viewScrollDelta,
      lastViewportStart: state.lastViewportStart,
      composerScrollTop: state.composerScrollTop,
      editorScrollTop: state.editorScrollTop,
      keysScrollTop: state.keysScrollTop,
      composerSelectionProjection: null,
      storySelectionProjection: null,
      map: state.map,
      request: state.request,
      record: { ...recordState, entryIndex, scrollTop: shell.scrollTop }
    }
  };
}

function recordEventPosition(recordState: GenerationRecordViewerState): string {
  if (recordState.list.status === "loading") return "loading…";
  if (recordState.list.status === "error") return "list failed";
  const total = recordState.list.summaries.length;
  return total === 0 ? "no events" : `event ${recordState.eventIndex + 1}/${total}`;
}

function recordHeader(
  recordState: GenerationRecordViewerState,
  summary: GenerationRecordSummary | null,
  width: number
): FrameLine[] {
  const detail = recordState.detail.status === "ready" ? recordState.detail.detail : null;
  const entryCount = visibleEntryCount(detail);
  const stored = detail === null
    ? ""
    : ` ━ ${entryCount} ${entryCount === 1 ? "entry" : "entries"}`
      + ` ━ ${pipelineCharacterCount(detail).toLocaleString("en-US")} chars stored`;
  const lines: FrameLine[] = [
    titleRule(`generation record ━ ${recordEventPosition(recordState)}${stored}`, width),
    [segment(summary === null
      ? ` take ${recordState.nodeId} · no event selected`
      : ` take ${recordState.nodeId} · kind ${generationRecordKindLabel(summary.kind)}`
        + (detail === null ? "" : ` · operation ${generationRecordOperationLabel(detail.prompt.operation)}`)
        + ` · created ${summary.createdAt}`, "chrome")],
    [segment(detail === null
      ? " provider unavailable"
      : ` provider ${detail.provider.provider} · model ${detail.provider.model}`
        + (detail.range === undefined ? "" : ` · range [${detail.range.start}, ${detail.range.end})`), "chrome")],
    [segment(detail === null
      ? " effective settings unavailable"
      : ` ${detail.effective.wireProtocol}`
        + (detail.effective.fields.length === 0
          ? " · no recorded fields"
          : ` · ${detail.effective.fields.map(generationRecordFieldText).join(" · ")}`), "chrome")]
  ];
  return lines.map((line) => fitLine(line, width));
}

function detailErrorText(error: GenerationRecordDetailError): string {
  if (error.kind === "missing") {
    return "This Generation Record is no longer available. It may have been deleted or superseded.";
  }
  if (error.kind === "corrupt") return `The server returned an invalid Generation Record. ${error.message}`;
  return `Could not load this Generation Record. ${error.message}`;
}

function emptyBody(text: string): { rows: RequestDocumentRow[]; starts: number[] } {
  return { rows: [{ line: [segment(` ${text}`, "prose · dim")], target: null }], starts: [] };
}

function recordBody(
  recordState: GenerationRecordViewerState,
  node: NodeStub | null,
  entryIndex: number,
  width: number
): { rows: RequestDocumentRow[]; starts: number[] } {
  if (recordState.list.status === "loading") return emptyBody("Loading this take's Generation Records…");
  if (recordState.list.status === "error") {
    return emptyBody(`Could not load this take's Generation Records. ${recordState.list.message}`);
  }
  if (recordState.list.summaries.length === 0) {
    return emptyBody("This take has no Generation Records.");
  }
  if (recordState.detail.status === "loading") return emptyBody("Loading this event's Generation Record…");
  if (recordState.detail.status === "error") return emptyBody(detailErrorText(recordState.detail.error));
  if (recordState.detail.status === "idle") return emptyBody("This event's Generation Record is not available.");
  const detail = recordState.detail.detail;

  const rows: RequestDocumentRow[] = [];
  const warning = humanEditWarning(node ?? undefined);
  if (warning !== null) rows.push(...noticeSection("human edit", [warning], width));
  rows.push(...noticeSection(
    "effective settings",
    [
      `wire protocol ${detail.effective.wireProtocol}`,
      ...detail.effective.fields.map(generationRecordFieldText)
    ],
    width
  ));
  rows.push(...noticeSection(
    "construction adjustments",
    adjustmentNotices(detail.effective.adjustments, "construction"),
    width
  ));
  rows.push(...noticeSection(
    "retry adjustments",
    adjustmentNotices(detail.effective.adjustments, "retry"),
    width
  ));
  if (detail.kind === "unsupported") {
    rows.push(...noticeSection(
      "unsupported",
      [detail.unsupportedReason ?? "This record could not be captured."],
      width
    ));
    return { rows, starts: [] };
  }
  const starts: number[] = [];
  const pipeline = generationRecordPipelineRows(detail);
  for (const row of pipeline) {
    starts.push(rows.length);
    rows.push(...pipelineEntryRows(row, row.index === entryIndex, width));
  }
  if (pipeline.length === 0) rows.push({ line: [segment(" no prompt messages", "prose · dim")], target: null });
  return { rows, starts };
}

function pipelineEntryRows(row: GenerationRecordPipelineRow, selected: boolean, width: number): RequestDocumentRow[] {
  const target: HitTarget = { kind: "list", index: row.index, rowId: `record-entry:${row.index}`, selected };
  const prefix = ` ${String(row.index + 1).padStart(2, "0")} ${row.label.toUpperCase()}`;
  const selection = selected ? { background: "focus / accent" as const, bold: true } : {};
  const header: FrameLine = [{
    ...segment(prefix, selected ? "background" : "focus / accent", target),
    ...selection
  }];
  return messageDocumentRows(target, header, row.content, width);
}

function recordBreadcrumb(state: StoryScreenState, recordState: GenerationRecordViewerState, width: number): FrameLine {
  const leafId = state.payload.path.at(-1)?.id ?? null;
  const tag = state.payload.tags.find((item) => item.nodeId === leafId) ?? null;
  const narrow = width < 100;
  const keys: FrameLine = [
    segment("←→", "focus / accent"),
    segment(" event", "chrome"),
    segment(" · ", "chrome"),
    segment("↑↓", "focus / accent"),
    segment(" entry", "chrome"),
    ...(narrow ? [] : [segment(" · ", "chrome"), segment("⇧↑↓ scroll", "chrome")]),
    ...(narrow ? [] : [segment(" · ", "chrome"), segment("g/G ends", "chrome")]),
    segment(" · ", "chrome"),
    segment("esc close", "focus / accent")
  ];
  return renderSurfaceBreadcrumb({
    mode: "RECORD",
    scope: narrow ? "records" : "generation records",
    title: state.payload.title,
    identity: tag === null ? "" : `${tagGlyph(tag.status)} ${tag.name}`,
    identityRole: tagRole(tag),
    crumb: recordEventPosition(recordState),
    keys,
    width
  });
}
