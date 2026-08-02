import { countWords } from "../../shared/story-text.js";
import type { StoryFact, StoryPayload } from "../../shared/types.js";
import type { UserConfig } from "./config.js";
import { factBody, factName } from "./facts-model.js";
import type { AppMode } from "./keys.js";
import type { ContextBreakdown, NextRequestEstimate } from "./request-projection.js";

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
  /** Included in the next generation request. */
  active: boolean;
  body: string;
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
  factCount: number;
  keyedFactCount: number;
  activeKeyedCount: number;
  contextTokens: number;
  /** Likely response tokens that become context after this request. */
  growthTokens: number;
  /** Configured max output tokens; secondary label only, never bar size. */
  maxOutputTokens: number;
  /** The configured window and this request against it, or null when the
   *  provider reports no window — the three are never known separately. */
  window: RequestWindow | null;
  breakdown: ContextBreakdown;
  chapterNotice: string | null;
}

/** Read-only mirror of the facts store and the next request projection. */
export function buildRailModel(
  payload: StoryPayload,
  _focusedText: string,
  contextWindow: number | null = null,
  estimate: NextRequestEstimate,
  growthTokens = 0,
  maxOutputTokens = 0
): RailModel {
  const activeFactIds = new Set(estimate.activeFactIds);
  const facts = payload.facts.map((fact: StoryFact, index): RailFact => {
    const name = factName(fact);
    return {
      index,
      name,
      tag: fact.tag ?? "",
      activation: fact.activation,
      active: activeFactIds.has(fact.id),
      body: factBody(fact)
    };
  });
  // The rail is a fixed-height window, so a long list gets cut. Facts the next
  // request uses outrank dormant ones: the cut falls on facts that are not
  // firing, never on the ones the rail exists to surface. Payload order breaks
  // ties, and each row keeps its payload index, so clicks are unaffected.
  const railRank = (fact: RailFact): number =>
    fact.activation === "keyed" ? (fact.active ? 0 : 2) : 1;
  facts.sort((left, right) => railRank(left) - railRank(right) || left.index - right.index);
  // Mirror what generation actually sends: the assembler drops everything
  // before the latest summary, and directions travel with their parts.
  const contextTokens = estimate.tokens;
  const responseGrowth = Math.max(0, growthTokens);
  const over = contextWindow !== null && contextWindow > 0
    && contextTokens + responseGrowth > contextWindow;
  const biggest = over ? estimate.chapters
    .filter((chapter) => chapter.included && chapter.closed && !chapter.summarized && chapter.savings > 0)
    .sort((left, right) => right.savings - left.savings)[0] ?? null : null;
  const stale = estimate.chapters.find((chapter) => chapter.included && chapter.summarized && chapter.stale) ?? null;
  return {
    facts,
    factCount: payload.facts.length,
    keyedFactCount: facts.filter(({ activation }) => activation === "keyed").length,
    activeKeyedCount: facts.filter(({ activation, active }) =>
      activation === "keyed" && active).length,
    contextTokens,
    growthTokens: responseGrowth,
    maxOutputTokens: Math.max(0, maxOutputTokens),
    window: requestWindow(contextTokens, contextWindow),
    breakdown: estimate.breakdown,
    chapterNotice: biggest !== null
      ? `ch ${biggest.number} · summarize frees ${formatTokensEstimate(biggest.savings)}`
      : stale !== null ? `ch ${stale.number} summary stale` : null
  };
}

/** `2.7k`, `8k`, `999` — scaled to a unit, never padded with a `.0`. */
export function formatTokensScaled(tokens: number): string {
  return scaleTokens(tokens, (scaled) => Number(scaled.toFixed(1)));
}

/** The same value as an estimate. Windows and free space are exact
 * consequences of the estimate, so only the estimate itself wears the `~`. */
export function formatTokensEstimate(tokens: number): string {
  return `~${formatTokensScaled(tokens)}`;
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
