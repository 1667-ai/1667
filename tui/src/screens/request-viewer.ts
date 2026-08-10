import type { FrameDeadlineCollector } from "../animation-deadline.js";
import type { HitRows, HitTarget } from "../hit.js";
import type { NextRequestContext, NextRequestEstimate } from "../request-projection.js";
import {
  breakdownFromPerMessage,
  formatTokensEstimate,
  formatTokensGraded,
  formatTokensScaled,
  resolveTokenCount,
  totalWithVisualTokens,
  type ResolvedTokenCount
} from "../rail.js";
import { imageAttachmentLabel, imageMediaTypeLabel } from "../../../shared/image-attachment.js";
import { formatImageBytes } from "../draft-image.js";
import type { PromptTokenCount, TokenCountGrade } from "../../../shared/tokenize-source.js";
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
  deadlines?: FrameDeadlineCollector,
  /** The lane's freshest answer for this exact projection, already
   *  freshness-checked by the caller — null when there is none to trust yet. */
  count: PromptTokenCount | null = null
) {
  const frame = renderRequestViewer(state, context, estimate, request, width, height, count);
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

/** Render the provider-neutral request plan as one terminal document.
 *  `count` is the lane's freshest answer for this exact projection, already
 *  freshness-checked by the caller — null renders every number as today's
 *  plain estimate. */
export function renderRequestViewer(
  story: RequestViewerStory,
  context: NextRequestContext,
  estimate: NextRequestEstimate,
  request: RequestViewerState,
  width: number,
  height: number,
  count: PromptTokenCount | null = null
): RequestViewerFrame {
  const resolved = resolveTokenCount(estimate, count);
  const header = requestHeader(context, estimate, story.model, story.contextWindow, width, resolved, count);
  const cursor = Math.max(0, Math.min(Math.max(0, estimate.messages.length - 1), request.cursor));
  const body = requestBody(estimate, width, cursor, resolved);
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

/** `tokens exact`, `tokens near-exact`, or `tokens estimated` — the route
 *  line's statement of where the header's and the body's numbers came from. */
function tokenSourceLabel(grade: TokenCountGrade): string {
  return grade === "exact" ? "tokens exact"
    : grade === "near-exact" ? "tokens near-exact"
    : "tokens estimated";
}

function requestHeader(
  context: NextRequestContext,
  estimate: NextRequestEstimate,
  model: string,
  contextWindow: number | null,
  width: number,
  resolved: ResolvedTokenCount,
  count: PromptTokenCount | null
): FrameLine[] {
  const totalWithVisual = totalWithVisualTokens(estimate, resolved, count);
  const window = contextWindow === null ? "unknown" : formatTokensScaled(contextWindow);
  const boundary = estimate.plan.requiresEcho
    ? "boundary echo"
    : estimate.messages.at(-1)?.role === "assistant" ? "assistant prefill" : "new passage";
  const routePrefix = ` operation ${context.operation} · model `;
  const windowAndBoundary = ` · context window ${window} · ${boundary}`;
  // The provenance statement yields before it would cost the model name its
  // last visible cell — the same width budget the neighbouring segments use,
  // widest candidate first (see requestValue in context-meter.ts).
  const suffixCandidates = [
    ` · context window ${window} · ${tokenSourceLabel(totalWithVisual.totalGrade)} · ${boundary}`,
    windowAndBoundary
  ];
  const routeSuffix = suffixCandidates.find((candidate) =>
    width - visibleWidth(routePrefix) - visibleWidth(candidate) >= 1
  ) ?? windowAndBoundary;
  const modelWidth = Math.max(0, width - visibleWidth(routePrefix) - visibleWidth(routeSuffix));
  const breakdown = { ...breakdownFromPerMessage(estimate.plan.entries, resolved.perMessage), visual: estimate.breakdown.visual };
  const lines: FrameLine[] = [
    titleLine(
      `next request ━ ${estimate.messages.length} messages ━ ${formatTokensGraded(totalWithVisual.total, totalWithVisual.totalGrade)}`,
      width
    ),
    [
      segment(routePrefix, "chrome"),
      segment(truncate(model, modelWidth), "chrome"),
      segment(routeSuffix, "chrome")
    ],
    [segment(
      ` voice ${formatTokensGraded(breakdown.voice, resolved.perMessageGrade)}`
        + ` · facts ${formatTokensGraded(breakdown.facts, resolved.perMessageGrade)}`
        + ` · note ${formatTokensGraded(breakdown.note, resolved.perMessageGrade)}`
        + ` · story ${formatTokensGraded(breakdown.recent, resolved.perMessageGrade)}`
        + ` · summaries ${formatTokensGraded(breakdown.summary, resolved.perMessageGrade)}`
        + (breakdown.visual > 0 ? ` · images ${formatTokensEstimate(breakdown.visual)}` : ""),
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
function activationNotices(estimate: NextRequestEstimate): string[] {
  const notices: string[] = [];
  for (const fact of estimate.activation.facts) {
    const trace = estimate.activation.traces.get(fact.id);
    if (trace === undefined || trace.kind === "always") continue;
    const identity = fact.tag?.trim() || fact.text.split("\n", 1)[0]?.trim() || fact.id;
    const gate = trace.gate === null ? "" : ` with ${trace.gate} secondary keys`;
    notices.push(`Fact ${identity} activated by ${trace.kind} key ${trace.key ?? ""}${gate}${trace.round > 0 ? ` in chain round ${trace.round}` : ""}.`);
  }
  if (estimate.activation.unevaluated.length > 0) {
    notices.push(`${estimate.activation.unevaluated.length} Fact regex key checks were not evaluated because the evaluation budget was reached.`);
  }
  return notices;
}

function requestBody(
  estimate: NextRequestEstimate,
  width: number,
  cursor: number,
  resolved: ResolvedTokenCount
): { rows: BodyRow[]; starts: number[] } {
  const rows: BodyRow[] = [];
  const starts: number[] = [];
  // Counts every image across the whole prompt in wire order, matching the
  // composer's own row numbering (shared/image-attachment.ts's
  // imageAttachmentLabel) rather than resetting per message.
  let imageOrdinal = 0;
  const substitutions = substitutionNotices(estimate);
  if (substitutions.length > 0) {
    rows.push(
      { line: [segment("─".repeat(Math.max(0, width)), "chrome")], target: null },
      { line: [segment(" substitutions", "focus / accent")], target: null }
    );
    for (const notice of substitutions) {
      rows.push(...wrapText(notice, [], Math.max(1, width - 3)).map(({ text }): BodyRow => ({
        line: [segment("  ", "chrome"), segment(text, "focus / accent")],
        target: null
      })));
    }
    rows.push({ line: [], target: null });
  }
  const activations = activationNotices(estimate);
  if (activations.length > 0) {
    rows.push(
      { line: [segment("─".repeat(Math.max(0, width)), "chrome")], target: null },
      { line: [segment(" activations", "focus / accent")], target: null }
    );
    for (const notice of activations) {
      rows.push(...wrapText(notice, [], Math.max(1, width - 3)).map(({ text }): BodyRow => ({
        line: [segment("  ", "chrome"), segment(text, "focus / accent")], target: null
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
    const tokenSuffix = ` · ${formatTokensGraded(resolved.perMessage[index]!, resolved.perMessageGrade)}`;
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
    // Image blocks carry no text (shared/prompt-plan.ts's ImagePromptBlock
    // has no `text` field), so `message.content` never describes them. This
    // renders their metadata explicitly, one row per image, ahead of the
    // wrapped text — and never a data URL: only the position, media type,
    // dimensions, byte length, and an estimated token count, the same
    // closed metadata shape the story bundle itself stores.
    for (const block of entry.turn.blocks) {
      if (block.kind !== "image") continue;
      imageOrdinal += 1;
      const attachment = block.image;
      const tokens = estimate.imageTokens.get(attachment.objectId);
      const label = `[${imageAttachmentLabel(imageOrdinal - 1)} · ${imageMediaTypeLabel(attachment.mediaType)}`
        + ` · ${attachment.width}×${attachment.height} · ${formatImageBytes(attachment.byteLength)}`
        + (tokens !== undefined && tokens > 0 ? ` · ${formatTokensEstimate(tokens)} tokens` : "")
        + "]";
      for (const wrapped of wrapText(label, [], Math.max(1, width - 4))) {
        rows.push({
          line: [segment("  ", "chrome"), segment(wrapped.text, "focus / accent")],
          target: null
        });
      }
    }
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
  // The placement the request really used, which may be clamped short of the
  // requested depth. No part follows the note when the story has none, and
  // "depth 0" is not a depth the writer can set, so name that placement.
  if (entry.category !== "note") return label;
  return entry.partsAfterNote === 0
    ? `${label} · before the request`
    : `${label} · depth ${entry.partsAfterNote}`;
}

function titleLine(title: string, width: number): FrameLine {
  const prefix = `━━ ${title} `;
  return [
    segment(prefix, "focus / accent"),
    segment("━".repeat(Math.max(0, width - visibleWidth(prefix))), "chrome")
  ];
}
