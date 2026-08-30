import type { FactBudgetDrop } from "../../shared/fact-budget.js";
import type { FactActivationTrace } from "../../shared/fact-activation.js";
import { canonicalFactStates, isFactEndState, resolveFactState } from "../../shared/fact-state.js";
import { createStoryIndex, lineName } from "../../shared/story-model.js";
import { pathTo } from "../../shared/story-tree.js";
import { countWords } from "../../shared/story-text.js";
import type { StoryFact, StoryPayload } from "../../shared/types.js";
import type { PromptTokenCount, TokenCountGrade } from "../../shared/tokenize-source.js";
import type { UserConfig } from "./config.js";
import {
  factBody,
  factName,
  factPathProjection,
  factStatusForPath,
  type FactPathProjection,
  type FactRequestStatus
} from "./facts-model.js";
import type { AppMode } from "./keys.js";
import type { ContextBreakdown, NextRequestEstimate } from "./request-projection.js";
import type { DisplayRole } from "./screens/story/frame.js";

export const RAIL_WIDTH = 34;
/** Usable cells after the rail's one-cell inner inset. */
export const RAIL_CONTENT_WIDTH = RAIL_WIDTH - 1;
export const RAIL_MIN_COLUMNS = 138;

export function railVisible(width: number, config: UserConfig, mode?: AppMode): boolean {
  const pageMode = mode === undefined || mode === "NAV" || mode === "COMPOSE";
  return pageMode && width >= RAIL_MIN_COLUMNS && config.factsRail === "auto";
}

export interface RailFact {
  /** Position in payload.facts; rail clicks open this exact fact. */
  index: number;
  name: string;
  tag: string;
  activation: StoryFact["activation"];
  /** Sent, not-matched, or dropped-with-reason — see tui/src/facts-model.ts. */
  status: FactRequestStatus;
  trace: FactActivationTrace | undefined;
  body: string;
  /** Compact state history and scope note shown beside the Fact name. */
  stateWhisper: string;
  stateWhisperRole: DisplayRole;
  /** Shedding rank under window pressure; "normal" is the default. */
  priority: NonNullable<StoryFact["priority"]>;
}

export interface RailFocusedContext {
  /** Payload index, so the read-only card keeps the same click target. */
  factIndex: number;
  name: string;
  stateWhisper: string;
  anchor: string;
  body: string;
  sibling: string | null;
}

export interface RequestWindow {
  size: number;
  /** Share of the window this request occupies; above 1 it does not fit. */
  fill: number;
  free: number;
  /** Tokens this request runs past the window. Zero while it still fits. */
  over: number;
}

/** The one place a request is measured against a window. A provider that
 * reports no window — or a nonsensical one — leaves every reader with `null`
 * rather than a percentage of nothing. */
export function requestWindow(tokens: number, size: number | null): RequestWindow | null {
  if (size === null || size <= 0) return null;
  return {
    size,
    fill: tokens / size,
    free: Math.max(0, size - tokens),
    over: Math.max(0, tokens - size)
  };
}

export interface RailModel {
  facts: RailFact[];
  /** The line currently under the story cursor, not a second persisted name. */
  lineName: string;
  /** One focused state card, when the cursor is on a Fact anchor. */
  focusedContext: RailFocusedContext | null;
  factCount: number;
  keyedFactCount: number;
  activeKeyedCount: number;
  contextTokens: number;
  /** Honesty of `contextTokens`: `estimate` until a tokenize source counts it. */
  totalGrade: TokenCountGrade;
  /** Honesty of `breakdown`'s category totals: `estimate` unless the source
   *  that counted `contextTokens` also split it per message. */
  perMessageGrade: TokenCountGrade;
  /** Likely response tokens that become context after this request. */
  growthTokens: number;
  /** Configured max output tokens; secondary label only, never bar size. */
  maxOutputTokens: number;
  /** The configured window and this request against it, or null when the
   *  provider reports no window — the three are never known separately. */
  window: RequestWindow | null;
  breakdown: ContextBreakdown;
  chapterNotice: string | null;
  /** Facts the story's own Facts budget shed out of this request; empty when
   *  nothing had to give. See RequestTokenEstimate.droppedFacts. */
  droppedFacts: readonly FactBudgetDrop[];
}

export interface ResolvedTokenCount {
  readonly total: number;
  readonly totalGrade: TokenCountGrade;
  /** Aligned one-to-one with the projected messages. */
  readonly perMessage: readonly number[];
  readonly perMessageGrade: TokenCountGrade;
}

/** Reconciles a counted answer against the client's own per-message estimate.
 * No count, an `estimate`-kind answer, and a `counted` answer with no
 * `perMessage` split all leave the total on the client's number — a count
 * that only covers the complete array earns the total its grade and nothing
 * else, per shared/tokenize-source.ts. A counted total can run ahead of the
 * summed per-message counts (a bundled tokenizer's reply-priming overhead
 * belongs to no message), so nothing here scales one to match the other. */
export function resolveTokenCount(
  estimate: Pick<NextRequestEstimate, "tokens" | "messageTokenCounts">,
  count: PromptTokenCount | null
): ResolvedTokenCount {
  if (count === null || count.kind !== "counted") {
    return {
      total: estimate.tokens,
      totalGrade: "estimate",
      perMessage: estimate.messageTokenCounts,
      perMessageGrade: "estimate"
    };
  }
  // A split has to line up with the messages it claims to describe. A shorter
  // one would leave a message row reading its count from past the end of the
  // array; the total still stands on its own, so only the split is refused.
  const split = count.perMessage !== null
    && count.perMessage.length === estimate.messageTokenCounts.length
    ? count.perMessage
    : null;
  return {
    total: count.total,
    totalGrade: count.grade,
    perMessage: split ?? estimate.messageTokenCounts,
    perMessageGrade: split !== null ? count.grade : "estimate"
  };
}

/** Category totals from a per-message array aligned with `entries` — the same
 * grouping `nextRequestEstimate` does for the client's own estimate, reused so
 * a counted per-message split earns identical category math.
 *
 * `visual` is never in `entries`/`perMessage` — `countPromptTokens` takes
 * text-only `ChatMessage[]`, so no image block ever reaches either — and
 * stays zero here regardless of what a caller passes. A caller that wants
 * the visual estimate folded in adds `estimate.breakdown.visual` itself, the
 * same way `totalWithVisualTokens` does for the combined total. */
export function breakdownFromPerMessage(
  entries: readonly { category: keyof ContextBreakdown }[],
  perMessage: readonly number[]
): ContextBreakdown {
  const breakdown: ContextBreakdown = { voice: 0, facts: 0, recent: 0, summary: 0, note: 0, visual: 0 };
  entries.forEach((entry, index) => {
    breakdown[entry.category] += perMessage[index] ?? 0;
  });
  return breakdown;
}

/** `resolveTokenCount`'s total covers text only: `countPromptTokens` never
 *  sees an image block, so a real provider count can never include visual
 *  tokens. `estimate.tokens` (the client-only fallback `resolveTokenCount`
 *  uses when there is no counted answer) already sums every
 *  `ContextBreakdown` category, visual included, so this only has to add
 *  the addend back on top of an actual counted total — and either way, a
 *  total with any estimated component downgrades to `"estimate"`: it is no
 *  longer exact the moment part of it is a guess. */
export function totalWithVisualTokens(
  estimate: Pick<NextRequestEstimate, "breakdown">,
  resolved: Pick<ResolvedTokenCount, "total" | "totalGrade">,
  count: PromptTokenCount | null
): { total: number; totalGrade: TokenCountGrade } {
  const visual = estimate.breakdown.visual;
  if (visual <= 0) return { total: resolved.total, totalGrade: resolved.totalGrade };
  const alreadyIncluded = count === null || count.kind !== "counted";
  return {
    total: alreadyIncluded ? resolved.total : resolved.total + visual,
    totalGrade: "estimate"
  };
}

/** Read-only mirror of the facts store and the next request projection.
 *  `count` is the lane's freshest answer for this exact projection, already
 *  freshness-checked by the caller — null when there is none to trust yet. */
export function buildRailModel(
  payload: StoryPayload,
  _focusedText: string,
  contextWindow: number | null = null,
  estimate: NextRequestEstimate,
  growthTokens = 0,
  maxOutputTokens = 0,
  count: PromptTokenCount | null = null,
  focusedPartId: string | null = null
): RailModel {
  // A continue from an earlier cursor part resolves Facts on the path up to
  // that seam. Keep the default full-path projection for older callers and
  // tests that do not provide cursor identity.
  const focusPathIndex = focusedPartId === null
    ? -1
    : payload.path.findIndex(({ id }) => id === focusedPartId);
  const pathIds = payload.path
    .slice(0, focusPathIndex < 0 ? payload.path.length : focusPathIndex + 1)
    .map(({ id }) => id);
  const fullPathIds = payload.path.map(({ id }) => id);
  const resolvedFacts = new Map<number, FactPathProjection>();
  const facts = payload.facts.map((fact: StoryFact, index): RailFact => {
    const path = factPathProjection(fact, pathIds);
    resolvedFacts.set(index, path);
    const status = factStatusForPath(
      fact,
      estimate.factStatuses.get(fact.id) ?? { kind: "not-matched" },
      pathIds,
      path
    );
    return {
      index,
      name: factName(fact, pathIds, path),
      tag: fact.tag ?? "",
      activation: fact.activation,
      status,
      trace: estimate.activation.traces.get(fact.id),
      body: factBody(fact, pathIds, path),
      ...stateWhisper(path, status, pathIds, fullPathIds),
      priority: fact.priority ?? "normal"
    };
  });
  // The rail is a fixed-height window, so a long list gets cut. Facts the next
  // request uses outrank dormant ones: the cut falls on facts that are not
  // firing, never on the ones the rail exists to surface. Payload order breaks
  // ties, and each row keeps its payload index, so clicks are unaffected.
  const railRank = (fact: RailFact): number =>
    fact.activation === "keyed" ? (fact.status.kind === "sent" ? 0 : 2) : 1;
  facts.sort((left, right) => railRank(left) - railRank(right) || left.index - right.index);
  // Mirror what generation actually sends: the assembler drops everything
  // before the latest summary, and directions travel with their parts.
  const resolved = resolveTokenCount(estimate, count);
  const totalWithVisual = totalWithVisualTokens(estimate, resolved, count);
  const contextTokens = totalWithVisual.total;
  const breakdown = { ...breakdownFromPerMessage(estimate.plan.entries, resolved.perMessage), visual: estimate.breakdown.visual };
  const responseGrowth = Math.max(0, growthTokens);
  const over = contextWindow !== null && contextWindow > 0
    && contextTokens + responseGrowth > contextWindow;
  const biggest = over ? estimate.chapters
    .filter((chapter) => chapter.included && chapter.closed && !chapter.summarized && chapter.savings > 0)
    .sort((left, right) => right.savings - left.savings)[0] ?? null : null;
  const stale = estimate.chapters.find((chapter) => chapter.included && chapter.summarized && chapter.stale) ?? null;
  const activeLeafId = payload.path.at(-1)?.id;
  const focusedContext = focusedPartId === null
    ? null
    : focusedFactContext(payload, facts, focusedPartId, pathIds, fullPathIds, resolvedFacts);
  return {
    facts,
    lineName: activeLeafId === undefined ? "story" : lineName(payload, activeLeafId),
    focusedContext,
    factCount: payload.facts.length,
    keyedFactCount: facts.filter(({ activation }) => activation === "keyed").length,
    activeKeyedCount: facts.filter(({ activation, status }) =>
      activation === "keyed" && status.kind === "sent").length,
    contextTokens,
    totalGrade: totalWithVisual.totalGrade,
    perMessageGrade: resolved.perMessageGrade,
    growthTokens: responseGrowth,
    maxOutputTokens: Math.max(0, maxOutputTokens),
    window: requestWindow(contextTokens, contextWindow),
    breakdown,
    droppedFacts: estimate.droppedFacts,
    chapterNotice: biggest !== null
      ? `ch ${biggest.number} · summarize frees ${formatTokensEstimate(biggest.savings)}`
      : stale !== null ? `ch ${stale.number} summary stale` : null
  };
}

/** Keep the state history visible without turning the read-only rail into a
 * second editor. The resolver remains the authority for the effective state;
 * this helper only gives that result a short, cell-friendly label. */
function stateWhisper(
  path: FactPathProjection,
  status: FactRequestStatus,
  pathIds: readonly string[],
  fullPathIds: readonly string[]
): Pick<RailFact, "stateWhisper" | "stateWhisperRole"> {
  const { states, resolution, stateIndex } = path;
  const total = states.length;
  if (status.kind === "off-path" || resolution.kind === "off-path") {
    return { stateWhisper: "other line", stateWhisperRole: "prose · dim" };
  }
  if (status.kind === "ended" || resolution.kind === "ended") {
    return { stateWhisper: "ended", stateWhisperRole: "context warning" };
  }
  if (status.kind === "sent") {
    const futureEnd = states.find((state) => {
      if (!isFactEndState(state) || state.anchorPartId === undefined) return false;
      const anchor = fullPathIds.indexOf(state.anchorPartId);
      return anchor >= pathIds.length;
    });
    if (futureEnd !== undefined) {
      const anchor = fullPathIds.indexOf(futureEnd.anchorPartId ?? "");
      return {
        stateWhisper: `✕ at ¶${anchor + 1} ↓`,
        stateWhisperRole: "context warning"
      };
    }
  }
  if (states.length === 1 && states[0]?.anchorPartId === undefined) {
    return { stateWhisper: "—", stateWhisperRole: "chrome" };
  }
  return {
    stateWhisper: `st.${Math.max(0, stateIndex) + 1}/${total}`,
    stateWhisperRole: "focus / accent"
  };
}

function focusedFactContext(
  payload: StoryPayload,
  facts: readonly RailFact[],
  focusedPartId: string,
  pathIds: readonly string[],
  fullPathIds: readonly string[],
  resolvedFacts: ReadonlyMap<number, FactPathProjection>
): RailFocusedContext | null {
  for (const fact of facts) {
    const source = payload.facts[fact.index];
    if (source === undefined) continue;
    if (fact.status.kind !== "sent") continue;
    const path = resolvedFacts.get(fact.index);
    if (path === undefined || path.resolution.kind !== "active"
      || path.resolution.state.anchorPartId !== focusedPartId) continue;
    const states = path.states;
    const stateIndex = path.stateIndex;
    const anchor = pathIds.indexOf(focusedPartId);
    // Only call a state a sibling when its Anchor is outside the active line.
    // Earlier states on this line are history, not sibling lore; future End
    // States are already represented by the row whisper above.
    const sibling = siblingStateOnOtherLine(payload, source, path.resolution.state.id, fullPathIds);
    return {
      factIndex: fact.index,
      name: fact.name,
      stateWhisper: `st.${Math.max(0, stateIndex) + 1}/${states.length}`,
      anchor: `◆ ¶${anchor + 1}`,
      body: fact.body,
      sibling: sibling === null ? null : `st.${states.findIndex(({ id }) => id === sibling.id) + 1} still rides · other line`
    };
  }
  return null;
}

/** Resolve a candidate against a valid root-to-anchor path before calling it
 * a sibling. This excludes earlier states on the current line, and refuses a
 * note when malformed or incomplete tree data cannot prove the relation. */
function siblingStateOnOtherLine(
  payload: StoryPayload,
  fact: StoryFact,
  currentStateId: string,
  fullPathIds: readonly string[]
): StoryFact["states"][number] | null {
  const index = createStoryIndex(payload);
  for (const state of canonicalFactStates(fact)) {
    if (state.id === currentStateId || isFactEndState(state) || state.anchorPartId === undefined) continue;
    if (fullPathIds.includes(state.anchorPartId)) continue;
    try {
      const candidatePath = pathTo(index.tree, state.anchorPartId);
      const resolution = resolveFactState(fact, candidatePath);
      if (resolution.kind === "active" && resolution.state.id === state.id) return state;
    } catch {
      // A read-only surface must not invent context from an invalid anchor.
    }
  }
  return null;
}

/** `2.7k`, `8k`, `999` — scaled to a unit, never padded with a `.0`. */
export function formatTokensScaled(tokens: number): string {
  return scaleTokens(tokens, (scaled) => Number(scaled.toFixed(1)));
}

/** The same value as an estimate. Windows and free space are exact
 * consequences of the estimate, so only the estimate itself wears the `~`. */
export function formatTokensEstimate(tokens: number): string {
  return `${tokenCountMark("estimate")}${formatTokensScaled(tokens)}`;
}

/** `exact` earns no mark, `near-exact` earns `≈`, and `estimate` keeps the `~`
 *  convention — the one place a grade becomes a glyph, so a call site marking
 *  an already-formatted number never re-derives this branch itself. */
export function tokenCountMark(grade: TokenCountGrade): string {
  return grade === "exact" ? "" : grade === "near-exact" ? "≈" : "~";
}

/** The scaled form marked with what its grade actually earned it — the one
 *  formatter every changed call site routes through instead of branching on
 *  grade itself. */
export function formatTokensGraded(tokens: number, grade: TokenCountGrade): string {
  return `${tokenCountMark(grade)}${formatTokensScaled(tokens)}`;
}

/** The narrowest form, for fixed-width columns: four cells, or five where the
 * value runs off the top of the scale — `123k` says as much as a one-decimal
 * `123.5k` would. */
export function formatTokensNarrow(tokens: number): string {
  return scaleTokens(tokens, (scaled) => Number(scaled.toFixed(scaled < 10 ? 1 : 0)));
}

const TOKEN_SCALES = [
  [1_000, "k"], [1_000_000, "m"], [1_000_000_000, "b"], [1_000_000_000_000, "t"]
] as const;

/** More than the largest unit can say in three digits. It carries its own
 * "more than", so no surface needs to mark it approximate a second time. */
export const OFF_SCALE_TOKENS = "999t+";

function scaleTokens(tokens: number, round: (scaled: number) => number): string {
  const value = Math.max(0, tokens);
  if (value < 1_000) return String(Math.round(value));
  for (const [scale, suffix] of TOKEN_SCALES) {
    const scaled = round(value / scale);
    // A count that rounds up into the next unit belongs to that unit: a legend
    // cell holds `1m`, never a wider `1000k`. Rounding in number space keeps
    // `8.0k` from ever being spelled out.
    if (scaled < 1_000) return `${scaled}${suffix}`;
  }
  // Past the largest unit no short form is honest, and no column could hold the
  // digits anyway. Say it is off the top of the scale.
  return OFF_SCALE_TOKENS;
}

export type ContextSeverity = "normal" | "warning" | "over";

export function contextSeverity(window: RequestWindow | null): ContextSeverity {
  if (window === null) return "normal";
  if (window.fill >= 1) return "over";
  return window.fill >= 0.8 ? "warning" : "normal";
}

/** Ink cells of a gauge that never lies at a glance: a partial fill always
 * keeps one ink and one free cell visible, and only exact 0/1 hit the ends. */
export function gaugeFill(fill: number, cells: number): number {
  if (cells <= 0 || fill <= 0) return 0;
  if (fill >= 1) return cells;
  return Math.max(1, Math.min(cells - 1, Math.floor(fill * cells)));
}

/** Human-written word counting for the daily ledger (kept in config for a
 *  possible future surface; nothing displays it today). */
export function humanWordsOf(text: string): number {
  return countWords(text);
}
