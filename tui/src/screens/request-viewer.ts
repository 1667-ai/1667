import type { FrameDeadlineCollector } from "../animation-deadline.js";
import type { HitRows, HitTarget } from "../hit.js";
import type { NextRequestContext, NextRequestEstimate } from "../request-projection.js";
import { formatTokensEstimate, formatTokensScaled } from "../rail.js";
import type { RequestViewerState, StoryScreenState } from "../state.js";
import { wrapText } from "../wrap.js";
import {
  fitLine,
  segment,
  truncate,
  visibleWidth,
  type FrameComposition,
  type FrameLine
} from "./story/frame.js";
import { renderConnectionBanner } from "./connection-banner.js";
import { renderSurfaceBreadcrumb } from "./surface-breadcrumb.js";
import { addInlineHits } from "./story/hits.js";
import { tagGlyph, tagRole } from "../tag-presentation.js";

export interface RequestViewerFrame extends FrameComposition {
  hitRows: HitRows;
  request: RequestViewerState;
}

interface BodyRow {
  line: FrameLine;
  target: HitTarget | null;
}

/** Connect the document to the story renderer without adding another story layout path. */
export function renderRequestViewerScreen(
  state: StoryScreenState,
  request: RequestViewerState,
  context: NextRequestContext,
  estimate: NextRequestEstimate,
  width: number,
  height: number,
  deadlines?: FrameDeadlineCollector
) {
  const frame = renderRequestViewer(state, context, estimate, request, width, height);
  return {
    lines: state.connection.down
      ? renderConnectionBanner(frame.lines, { ...state, hitRows: frame.hitRows }, width, deadlines)
      : frame.lines,
    selectable: frame.selectable,
    derived: {
      hitRows: frame.hitRows,
      viewScroll: state.viewScroll,
      viewScrollDelta: state.viewScrollDelta,
      lastViewportStart: state.lastViewportStart,
      composerScrollTop: state.composerScrollTop,
      editorScrollTop: state.editorScrollTop,
      keysScrollTop: state.keysScrollTop,
      composerSelectionProjection: null,
      storySelectionProjection: null,
      map: state.map,
      request: frame.request
    }
  };
}

export type RequestViewerStory =
  Pick<StoryScreenState, "payload" | "model" | "contextWindow">;

/** Render the provider-neutral request plan as one terminal document. */
export function renderRequestViewer(
  story: RequestViewerStory,
  context: NextRequestContext,
  estimate: NextRequestEstimate,
  request: RequestViewerState,
  width: number,
  height: number
): RequestViewerFrame {
  const header = requestHeader(context, estimate, story.model, story.contextWindow, width);
  const cursor = Math.max(0, Math.min(Math.max(0, estimate.messages.length - 1), request.cursor));
  const body = requestBody(estimate, width, cursor);
  const bodyHeight = Math.max(0, height - header.length - 2);
  const maxScroll = Math.max(0, body.rows.length - bodyHeight);
  const reveal = body.starts[cursor] ?? 0;
  const requestedScroll = request.scrollTop < 0
    ? cursor === 0 ? 0 : Math.max(0, Math.min(maxScroll, reveal - 1))
    : request.scrollTop;
  const scrollTop = Math.max(0, Math.min(maxScroll, requestedScroll));
  const visible = body.rows.slice(scrollTop, scrollTop + bodyHeight);
  const padded: BodyRow[] = [
    ...visible,
    ...Array.from({ length: Math.max(0, bodyHeight - visible.length) }, (): BodyRow => ({
      line: [], target: null
    }))
  ];
  const footer: FrameLine[] = [
    [segment("─".repeat(Math.max(0, width)), "chrome")],
    requestBreadcrumb(story, estimate, cursor, width)
  ];
  const rows = [
    ...header.map((line): BodyRow => ({ line, target: null })),
    ...padded,
    ...footer.map((line): BodyRow => ({ line, target: null }))
  ].slice(0, height);
  const lines = rows.map(({ line }) => fitLine(line, width));
  const hitRows: HitRows = rows.map(({ target }) => target === null
    ? null
    : { target, left: 0, right: width });
  // The breadcrumb's keys carry their actions on their own segments, the way
  // the map's and search's do; without this they are painted text.
  const breadcrumb = lines.length - 1;
  if (lines[breadcrumb] !== undefined) {
    addInlineHits([lines[breadcrumb]!], hitRows, () => true, breadcrumb);
  }
  return { lines, selectable: null, hitRows, request: { ...request, cursor, scrollTop } };
}

/** C-02: the surface keeps its mode cell and its tether back to the story.
 *  The viewer used to end on a bare keyline, so `REQUEST` never named itself
 *  and nothing on screen said which story you were inspecting. */
function requestBreadcrumb(
  story: RequestViewerStory,
  estimate: NextRequestEstimate,
  cursor: number,
  width: number
): FrameLine {
  const leafId = story.payload.path.at(-1)?.id ?? null;
  const tag = story.payload.tags.find((item) => item.nodeId === leafId) ?? null;
  const total = estimate.messages.length;
  const narrow = width < 100;
  const keys: FrameLine = [
    segment("↑", "chrome", { kind: "action", action: "focus-previous" }),
    segment("↓", "chrome", { kind: "action", action: "focus-next" }),
    segment(" message", "chrome"),
    segment(" · ", "chrome"),
    segment("⇧↑↓ scroll", "chrome"),
    ...(narrow ? [] : [segment(" · ", "chrome"), segment("g/G ends", "chrome")]),
    segment(" · ", "chrome"),
    segment("esc close", "focus / accent", { kind: "action", action: "cancel" })
  ];
  return renderSurfaceBreadcrumb({
    mode: "REQUEST",
    scope: narrow ? "next" : "next request",
    title: story.payload.title,
    identity: tag === null ? "" : `${tagGlyph(tag.status)} ${tag.name}`,
    identityRole: tagRole(tag),
    crumb: total === 0 ? "no messages" : `message ${cursor + 1}/${total}`,
    keys,
    width
  });
}

function requestHeader(
  context: NextRequestContext,
  estimate: NextRequestEstimate,
  model: string,
  contextWindow: number | null,
  width: number
): FrameLine[] {
  const window = contextWindow === null ? "unknown" : formatTokensScaled(contextWindow);
  const boundary = estimate.plan.requiresEcho
    ? "boundary echo"
    : estimate.messages.at(-1)?.role === "assistant" ? "assistant prefill" : "new passage";
  const routePrefix = ` operation ${context.operation} · model `;
  const routeSuffix = ` · context window ${window} · ${boundary}`;
  const modelWidth = Math.max(0, width - visibleWidth(routePrefix) - visibleWidth(routeSuffix));
  const lines: FrameLine[] = [
    titleLine(`next request ━ ${estimate.messages.length} messages ━ ${formatTokensEstimate(estimate.tokens)}`, width),
    [
      segment(routePrefix, "chrome"),
      segment(truncate(model, modelWidth), "chrome"),
      segment(routeSuffix, "chrome")
    ],
    [segment(
      ` voice ${formatTokensEstimate(estimate.breakdown.voice)} · facts ${formatTokensEstimate(estimate.breakdown.facts)} · note ${formatTokensEstimate(estimate.breakdown.note)} · story ${formatTokensEstimate(estimate.breakdown.recent)} · summaries ${formatTokensEstimate(estimate.breakdown.summary)}`,
      "chrome"
    )]
  ];
  return lines.map((line) => fitLine(line, width));
}

function substitutionNotices(estimate: NextRequestEstimate): string[] {
  return estimate.substitutions.map((substitution) => {
    if (substitution.kind === "legacy-summary") {
      const count = substitution.omittedPartCount;
      return `Summary take ${substitution.summaryId} starts the raw context. ${count} earlier ${count === 1 ? "part is" : "parts are"} omitted.`;
    }
    const count = substitution.replacedPartIds.length;
    const ids = substitution.replacedPartIds.join(", ");
    return `Chapter ${substitution.chapterNumber} uses summary ${substitution.summaryId} (${formatTokensEstimate(substitution.tokens)}) instead of ${count} raw ${count === 1 ? "part" : "parts"}${ids.length === 0 ? "." : `: ${ids}.`}`;
  });
}

function requestBody(
  estimate: NextRequestEstimate,
  width: number,
  cursor: number
): { rows: BodyRow[]; starts: number[] } {
  const rows: BodyRow[] = [];
  const starts: number[] = [];
  const notices = substitutionNotices(estimate);
  if (notices.length > 0) {
    rows.push(
      { line: [segment("─".repeat(Math.max(0, width)), "chrome")], target: null },
      { line: [segment(" substitutions", "focus / accent")], target: null }
    );
    for (const notice of notices) {
      rows.push(...wrapText(notice, [], Math.max(1, width - 3)).map(({ text }): BodyRow => ({
        line: [segment("  ", "chrome"), segment(text, "focus / accent")],
        target: null
      })));
    }
    rows.push({ line: [], target: null });
  }
  for (const [index, message] of estimate.messages.entries()) {
    starts.push(rows.length);
    const entry = estimate.plan.entries[index]!;
    const selected = index === cursor;
    const target: HitTarget = {
      kind: "list",
      index,
      rowId: requestRowIdentity(entry),
      selected
    };
    rows.push({
      line: [
        segment("─".repeat(Math.max(0, width)), "chrome", target)
      ],
      target
    });
    const source = entrySource(entry);
    const messagePrefix = ` ${String(index + 1).padStart(2, "0")} ${message.role.toUpperCase()} · ${entry.category} · `;
    const tokenSuffix = ` · ${formatTokensEstimate(estimate.messageTokenCounts[index]!)}`;
    const sourceWidth = Math.max(
      0,
      width - visibleWidth(messagePrefix) - visibleWidth(tokenSuffix)
    );
    // The selected header is an inverted block, not tinted prose: prose ink on
    // the accent is light on light in every warm theme.
    const selection = selected
      ? { background: "focus / accent" as const, bold: true }
      : {};
    rows.push({
      line: [
        {
          ...segment(messagePrefix, selected ? "background" : "focus / accent", target),
          ...selection
        },
        {
          ...segment(truncate(source, sourceWidth), selected ? "background" : "focus / accent", target),
          ...selection
        },
        segment(tokenSuffix, "chrome", target)
      ],
      target
    });
    for (const wrapped of wrapText(message.content, [], Math.max(1, width - 4))) {
      rows.push({
        line: [segment("  ", "chrome"), segment(wrapped.text, "prose")],
        target: null
      });
    }
    rows.push({ line: [], target: null });
  }
  if (rows.length === 0) rows.push({ line: [segment(" no prompt messages", "prose · dim")], target: null });
  return { rows, starts };
}

function requestRowIdentity(entry: NextRequestEstimate["plan"]["entries"][number]): string {
  return `request:${JSON.stringify([
    entry.category,
    entry.turn.role,
    entry.turn.blocks.map((block) => block.kind),
    entry.partId ?? null
  ])}`;
}

function entrySource(entry: NextRequestEstimate["plan"]["entries"][number]): string {
  const kind = entry.turn.blocks[0]?.kind ?? "source";
  if (entry.partId !== undefined) return `${kind} ${entry.partId}`;
  const label = kind.replaceAll("-", " ");
  // The effective placement, which may be clamped short of the requested
  // depth — the request viewer must show what the request actually sent.
  return entry.category === "note" ? `${label} · depth ${entry.depth}` : label;
}

function titleLine(title: string, width: number): FrameLine {
  const prefix = `━━ ${title} `;
  return [
    segment(prefix, "focus / accent"),
    segment("━".repeat(Math.max(0, width - visibleWidth(prefix))), "chrome")
  ];
}
