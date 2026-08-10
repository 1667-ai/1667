import type { StoryPart } from "../../model.js";
import type { StoryScreenState, StreamView } from "../../state.js";
import {
  MAX_HUMAN_EDIT_RANGES,
  MAX_REWRITTEN_SPANS,
  type StoryNode,
  type TextRange
} from "../../../../shared/types.js";
import {
  STARTER_LOGO_LINES,
  STARTER_LOGO_TEXT
} from "../../../../shared/starter-vault.js";
import { visibleWidth } from "./frame.js";
import { type ProseStyle, type StyleRun, type WrapCache, type WrapContentIdentity } from "../../wrap.js";
import { streamTrimBounds } from "../../stream-text.js";

export interface StoryPartWrapPlan {
  partId: string;
  width: number;
  text: string;
  runs: readonly StyleRun<ProseStyle>[];
  sourceStart: number;
  compactLogo: boolean;
  identity: WrapContentIdentity;
  stream: StreamView | null;
  appending: boolean;
  appendStart: number | null;
}

export interface StoryPartWrapInput {
  id: string;
  node: Pick<StoryNode, "text">;
  isSummary: boolean;
  humanSpans: readonly TextRange[];
  /** Ranges of prose a rewrite replaced (issue #319) — see `humanSpans`. */
  rewrittenSpans: readonly TextRange[];
}

export function wrapPart(
  part: StoryPart,
  stream: StreamView | null,
  measure: number,
  cache: WrapCache<ProseStyle>,
  identityContext: { source: object; settledLength: number },
  sourceStart?: number
) {
  const plan = storyPartWrapPlan(
    part,
    stream,
    measure,
    identityContext.settledLength,
    identityContext.source,
    stream,
    sourceStart
  );
  return {
    stream: plan.stream,
    appending: plan.appending,
    sourceStart: plan.sourceStart,
    compactLogo: plan.compactLogo,
    wrapped: cache.wrap(plan.partId, plan.width, plan.text, plan.runs, plan.identity)
  };
}

/** Canonical prose-wrap input shared by synchronous rows and cold prewarming. */
export function storyPartWrapPlan(
  part: StoryPartWrapInput,
  stream: StreamView | null,
  measure: number,
  settledLength = part.node.text.length,
  identitySource: object = part.node,
  streamIdentity: object | null = stream,
  projectedSourceStart?: number
): StoryPartWrapPlan {
  const appending = stream?.append === true;
  const sourceText = part.node.text;
  const width = measure - (part.isSummary ? 2 : 0);
  const sourceStart = projectedSourceStart
    ?? (part.isSummary ? 0 : starterLogoSourceStart(sourceText, part.humanSpans, width));
  const text = sourceStart === 0 ? sourceText : sourceText.slice(sourceStart);
  // Wrapping aligns style boundaries while it already owns grapheme
  // segmentation. Keeping this raw avoids a second uninterruptible scan before
  // resumable cold work begins.
  const sourceStreamingStart = appending && sourceText.length > settledLength
    ? Math.max(0, settledLength)
    : null;
  const streamingStart = sourceStreamingStart === null
    ? null
    : Math.max(0, sourceStreamingStart - sourceStart);
  const logoRuns: StyleRun<ProseStyle>[] = sourceStart === 0
    ? starterLogoRuns(text, part.humanSpans)
    : [];
  const humanRuns = provenanceRuns(part.humanSpans, MAX_HUMAN_EDIT_RANGES, sourceStart, text.length, "human");
  // A rewritten span (issue #319) marks prose the model wrote over the
  // writer's own words — a weaker claim than a human span, which means the
  // writer touched the passage since. A human edit over a rewritten span
  // already reclaims it server-side (`rewrittenSpansAfterHumanEdit`,
  // shared/human-edit.ts), so the two should rarely overlap by the time a
  // plan reaches here — but `resolveProvenanceOverlay` below resolves any
  // overlap and orders the result the same way regardless, rather than
  // trusting that argument. The wrap engine paints every style run it is
  // given, in the order given, without sorting or blending
  // (materialize-runs, wrap.ts; clipRuns, wrap.ts), so an unresolved overlap
  // or an out-of-order run would draw the same characters twice.
  const rewrittenRuns = provenanceRuns(part.rewrittenSpans, MAX_REWRITTEN_SPANS, sourceStart, text.length, "rewritten");
  let runs = resolveProvenanceOverlay(logoRuns, humanRuns, rewrittenRuns);
  if (streamingStart !== null) {
    // Every provenance run must end at or before the streaming boundary for
    // the streaming run to stay last and the whole list to stay ascending.
    // Truncate the merged list against that boundary here, once, instead of
    // arguing separately that each family (in particular the starter logo,
    // never otherwise clipped to it) already stays inside it. This step
    // alone only removes the overlap with [streamingStart, text.length) —
    // it does not by itself guarantee every survivor ends at or before
    // text.length, since a run could originally have reached past it. That
    // guarantee is `provenanceRuns`'s clamp, above (Fix 2, issue #319
    // review): without it, a run's tail past text.length survived this
    // subtraction as a piece sitting *after* [streamingStart, text.length)
    // in source order but pushed into the array *before* the streaming run
    // below — ascending within the family, non-ascending overall, the same
    // shape Fix 1 exists to rule out.
    runs = subtractAscending(runs, [{ start: streamingStart, end: text.length }]);
    runs.push({ start: streamingStart, end: text.length, style: "streaming" });
  }
  return {
    partId: part.id,
    width,
    text,
    runs,
    sourceStart,
    compactLogo: sourceStart > 0,
    identity: storyPartWrapIdentity(
      part,
      stream,
      settledLength,
      identitySource,
      streamIdentity
    ),
    stream,
    appending,
    appendStart: streamingStart
  };
}

/** Shift and clip one span family (human or rewritten) into runs over the
 *  already-sliced wrap text, in the caller's declared style. `sourceStart`
 *  and the cap match the semantics `storyPartWrapPlan` already applied
 *  before this split existed; the streaming boundary is no longer clipped
 *  here — `resolveProvenanceOverlay`'s caller clips the merged result once,
 *  uniformly, including the starter logo this function never sees.
 *
 *  `textLength` additionally clamps every run's end to the wrap text itself
 *  (Fix 2, issue #319 review). Nothing here can prove a persisted span never
 *  names an offset past the node's current text — `validateNodeRewrittenSpans`
 *  and `validateVersionAttributions` (server/story-format.ts) reject that on
 *  encode and decode, but this view has no way to prove it only ever sees
 *  payloads those checks passed, and re-arguing that on every call is the
 *  "by argument" gap the rest of this module deliberately avoids. Clamping
 *  here, unconditionally, is what makes it hold by construction instead: an
 *  unclamped run surviving past `text.length` produced a stray piece *after*
 *  the streaming-boundary subtraction below, landing before the streaming
 *  run pushed next — non-ascending, the exact shape Fix 1 exists to rule
 *  out. */
function provenanceRuns(
  spans: readonly TextRange[],
  cap: number,
  sourceStart: number,
  textLength: number,
  style: ProseStyle
): StyleRun<ProseStyle>[] {
  const count = Math.min(spans.length, cap);
  const runs: StyleRun<ProseStyle>[] = [];
  for (let index = 0; index < count; index += 1) {
    const range = spans[index]!;
    const start = Math.max(range.start, sourceStart) - sourceStart;
    const end = Math.min(range.end - sourceStart, textLength);
    if (end > start) runs.push({ start, end, style });
  }
  return runs;
}

/** Merge the starter-logo, human, and rewritten run families into one
 *  ascending, disjoint list — replacing the three hand-ordered
 *  concatenations this diff found (logo first, then every human span, then
 *  every rewritten span), which is ascending within each family but not
 *  overall: a rewritten span earlier in the text landed after a human span
 *  starting later, and the renderer (`styledWrapped`, row-layout.ts) walks
 *  runs with a single monotonic cursor, so the run out of order re-sliced
 *  text its cursor had already passed and drew it twice. A human span wins
 *  any overlap with a rewritten span; both win over the merely decorative
 *  starter logo. Overlap should be rare in practice (see the call site's
 *  comment), but resolving it here, unconditionally, is what makes the
 *  invariant hold by construction rather than by that argument — including
 *  for the starter logo, whose own pristine check does not itself rule out
 *  a rewritten span landing inside it.
 *
 *  `humanRuns` and `rewrittenRuns` each arrive ascending and pairwise
 *  disjoint within their own family — guaranteed at the parse boundary
 *  (`parseRewrittenSpans`, `parseVersionAttributions`, server/story-format-
 *  facts.ts), which reject unsorted, overlapping, or non-positive ranges on
 *  load. That is exactly what lets `subtractAscending` and `mergeAscending`
 *  below settle every overlap and every ordering with one linear pass each,
 *  in place of a per-run call into the general-purpose `subtractRanges`
 *  (shared/human-edit.ts) plus a final sort: on this render-path call, once
 *  per visible row per frame, that per-run approach cost O(runs × cuts)
 *  allocations — 2.17 ms for one part at the 256-human/256-rewritten cap,
 *  roughly 65 ms across 30 visible rows — against 0.008 ms for the merge
 *  below on the same input (Fix 1, issue #319 review). */
function resolveProvenanceOverlay(
  logoRuns: readonly StyleRun<ProseStyle>[],
  humanRuns: readonly StyleRun<ProseStyle>[],
  rewrittenRuns: readonly StyleRun<ProseStyle>[]
): StyleRun<ProseStyle>[] {
  const rewritten = subtractAscending(rewrittenRuns, humanRuns);
  const human = mergeAscending(humanRuns, rewritten);
  const logo = subtractAscending(logoRuns, human);
  return mergeAscending(human, logo);
}

/** Subtract an ascending, pairwise-disjoint list of `cuts` from an
 *  ascending, pairwise-disjoint list of `runs`, keeping each survivor's own
 *  style, in one linear pass over both instead of a nested one. `cutIndex`
 *  only ever advances, across the whole call, because both lists are
 *  ascending: no run can need a cut that an earlier run had already fully
 *  passed. A single-range `cuts` list (the streaming-boundary call below)
 *  trivially satisfies "ascending and disjoint" too, so this one function
 *  serves both that call and `resolveProvenanceOverlay` above. */
function subtractAscending(
  runs: readonly StyleRun<ProseStyle>[],
  cuts: readonly TextRange[]
): StyleRun<ProseStyle>[] {
  const result: StyleRun<ProseStyle>[] = [];
  let cutIndex = 0;
  for (const run of runs) {
    let start = run.start;
    while (start < run.end) {
      while (cutIndex < cuts.length && cuts[cutIndex]!.end <= start) cutIndex += 1;
      const cut = cuts[cutIndex];
      if (cut === undefined || cut.start >= run.end) {
        result.push({ start, end: run.end, style: run.style });
        break;
      }
      if (cut.start > start) result.push({ start, end: cut.start, style: run.style });
      start = Math.max(start, cut.end);
    }
  }
  return result;
}

/** Interleave two ascending, pairwise-disjoint run lists into one ascending
 *  list — the merge step of a merge sort, safe to use without the sort
 *  itself because both inputs already arrive ordered. Replaces the
 *  `[...a, ...b].sort(...)` `resolveProvenanceOverlay` used to close with,
 *  which re-sorted an already-mostly-ordered list on every call regardless
 *  of whether either family was even present. */
function mergeAscending(
  left: readonly StyleRun<ProseStyle>[],
  right: readonly StyleRun<ProseStyle>[]
): StyleRun<ProseStyle>[] {
  const merged: StyleRun<ProseStyle>[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    merged.push(left[leftIndex]!.start <= right[rightIndex]!.start
      ? left[leftIndex++]!
      : right[rightIndex++]!);
  }
  while (leftIndex < left.length) merged.push(left[leftIndex++]!);
  while (rightIndex < right.length) merged.push(right[rightIndex++]!);
  return merged;
}

const STARTER_LOGO_STYLES = [
  "logo red",
  "logo orange",
  "logo yellow",
  "logo green",
  "logo cyan",
  "logo blue",
  "logo violet"
] as const satisfies readonly ProseStyle[];

const STARTER_LOGO_PREFIX = `${STARTER_LOGO_TEXT}\n\n`;
const STARTER_LOGO_WIDTH = Math.max(...STARTER_LOGO_LINES.map(visibleWidth));

function hasPristineStarterLogo(text: string, humanSpans: readonly TextRange[]): boolean {
  return text.startsWith(STARTER_LOGO_PREFIX)
    && !humanSpans.some((range) => range.start < STARTER_LOGO_TEXT.length);
}

export function starterLogoSourceStart(
  text: string,
  humanSpans: readonly TextRange[],
  measure: number
): number {
  return measure < STARTER_LOGO_WIDTH && hasPristineStarterLogo(text, humanSpans)
    ? STARTER_LOGO_PREFIX.length
    : 0;
}

/** Match the complete prefix. An edited or partial logo becomes ordinary
 * prose, which keeps a user change authoritative and avoids hidden markup. */
function starterLogoRuns(
  text: string,
  humanSpans: readonly TextRange[]
): StyleRun<ProseStyle>[] {
  if (!hasPristineStarterLogo(text, humanSpans)) return [];
  const runs: StyleRun<ProseStyle>[] = [];
  let lineStart = 0;
  for (const line of STARTER_LOGO_LINES) {
    for (let band = 0; band < STARTER_LOGO_STYLES.length; band += 1) {
      const start = lineStart + band * 3;
      const end = Math.min(start + 3, lineStart + line.length);
      if (start < end) runs.push({ start, end, style: STARTER_LOGO_STYLES[band]! });
    }
    lineStart += line.length + 1;
  }
  return runs;
}

/** O(1) content proof for immutable payload prose and one append-only stream.
 * The raw text remains on the plan for cold work, never for warm comparison. */
export function storyPartWrapIdentity(
  part: StoryPartWrapInput,
  stream: StreamView | null,
  settledLength: number,
  source: object,
  streamIdentity: object | null
): WrapContentIdentity {
  const appending = stream?.append === true;
  const streamingStart = appending && part.node.text.length > settledLength
    ? Math.max(0, settledLength)
    : null;
  const contentStream = stream === null
    || streamIdentity === null
    || appending && streamingStart === null
    ? null
    : streamIdentity;
  const bounds = contentStream === null
    ? { start: 0, end: 0 }
    : appending
      ? { start: 0, end: stream!.text.length }
      : streamTrimBounds(stream!);
  return {
    source,
    stream: contentStream,
    streamStart: bounds.start,
    streamEnd: bounds.end,
    textLength: part.node.text.length
  };
}

export function wrapIdentityContext(
  part: StoryPart,
  state: StoryScreenState
): { source: object; settledLength: number } {
  const authoritative = state.payload.path[part.pathIndex];
  const source = authoritative?.id === part.id ? authoritative : state.payload;
  return {
    source,
    settledLength: authoritative?.id === part.id
      ? authoritative.text.length
      : part.node.text.length
  };
}
