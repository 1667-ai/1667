import type { FactActivationTrace } from "../../shared/fact-activation.js";
import { canonicalFactStates, isFactEndState, resolveFactState } from "../../shared/fact-state.js";
import { createStoryIndex, lineName } from "../../shared/story-model.js";
import { pathTo } from "../../shared/story-tree.js";
import { countWords } from "../../shared/story-text.js";
import type { StoryFact, StoryPayload } from "../../shared/types.js";
import type { PromptTokenCount } from "../../shared/tokenize-source.js";
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
import type { NextRequestEstimate } from "../../shared/request-projection.js";
import { buildContextMeterModel, type ContextMeterModel } from "../../shared/rail-model.js";
import type { DisplayRole } from "./screens/story/frame.js";

// The pure meter model lives in `shared/` (the web composer uses it too).
export {
  breakdownFromPerMessage,
  contextSeverity,
  formatTokensEstimate,
  formatTokensGraded,
  formatTokensNarrow,
  formatTokensScaled,
  gaugeFill,
  OFF_SCALE_TOKENS,
  requestWindow,
  resolveTokenCount,
  tokenCountMark,
  totalWithVisualTokens,
  type ContextSeverity,
  type RequestWindow,
  type ResolvedTokenCount
} from "../../shared/rail-model.js";

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

export interface RailModel extends ContextMeterModel {
  facts: RailFact[];
  /** The line currently under the story cursor, not a second persisted name. */
  lineName: string;
  /** One focused state card, when the cursor is on a Fact anchor. */
  focusedContext: RailFocusedContext | null;
  factCount: number;
  keyedFactCount: number;
  activeKeyedCount: number;
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
  const meter = buildContextMeterModel(estimate, contextWindow, growthTokens, maxOutputTokens, count);
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
    ...meter
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

/** Human-written word counting for the daily ledger (kept in config for a
 *  possible future surface; nothing displays it today). */
export function humanWordsOf(text: string): number {
  return countWords(text);
}
