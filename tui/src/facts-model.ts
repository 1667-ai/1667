import type { FactActivation } from "../../shared/fact-metadata.js";
import type { FactActivationTrace } from "../../shared/fact-activation.js";
import type { FactBudgetDrop, FactDropReason } from "../../shared/fact-budget.js";
import { countNoun } from "../../shared/fidelity.js";
import type { StoryFact, StoryPayload } from "../../shared/types.js";
import {
  canonicalFactStates,
  factStateText,
  firstFactText,
  isFactStateful,
  isFactEndState,
  resolveFactState,
  type FactState,
  type FactStateResolution,
} from "../../shared/fact-state.js";
import { lineName, rememberedLeafId } from "../../shared/story-model.js";
import { fuzzyFilter } from "./fuzzy.js";
import type { DisplayRole } from "./screens/story/frame.js";

/** Shared state access. The TUI only adds path-id convenience and labels. */
export const factStates = canonicalFactStates;
export { canonicalFactStates, factStateText, resolveFactState } from "../../shared/fact-state.js";

/** The four scope chips are a view filter. `everywhere` is the inclusive
 * default: it keeps the one-row-per-Fact overlay useful as a complete index.
 * The other chips select the effective relation to the current path. */
export const FACT_SCOPE_FILTERS = ["everywhere", "this-line", "elsewhere", "ended"] as const;
export type FactScopeFilter = (typeof FACT_SCOPE_FILTERS)[number];

export type FactScopeKind = "everywhere" | "this-line" | "elsewhere" | "ended";

/** One path query shared by read-only Fact surfaces. The display text is the
 * effective state text when one resolves, or the first text state as a useful
 * off-path fallback; it is never a second persisted value. */
export interface FactPathProjection {
  readonly states: readonly FactState[];
  readonly resolution: FactStateResolution;
  readonly stateIndex: number;
  readonly displayText: string;
  readonly scope: FactScopeKind;
}

export function factPathProjection(
  fact: StoryFact,
  pathIds: readonly string[] = []
): FactPathProjection {
  const states = canonicalFactStates(fact);
  const resolution = resolveFactState(fact, pathParts(pathIds));
  const stateIndex = resolution.kind === "off-path"
    ? -1
    : states.findIndex(({ id }) => id === resolution.state.id);
  const scope = isSingleUnscopedTextFact(fact)
    ? "everywhere"
    : resolution.kind === "off-path" ? "elsewhere"
      : resolution.kind === "ended" ? "ended"
        : resolution.state.anchorPartId === undefined ? "everywhere" : "this-line";
  return {
    states,
    resolution,
    stateIndex,
    displayText: resolution.kind === "active" ? factStateText(resolution.state) ?? "" : firstFactText(fact),
    scope
  };
}

export function factScopeForPath(
  fact: StoryFact,
  pathIds: readonly string[] = [],
  projection: FactPathProjection = factPathProjection(fact, pathIds)
): FactScopeKind {
  return projection.scope;
}

function factMatchesScope(
  fact: StoryFact,
  filter: FactScopeFilter,
  pathIds: readonly string[]
): boolean {
  return filter === "everywhere" || factScopeForPath(fact, pathIds) === filter;
}

function pathParts(pathIds: readonly string[]): readonly { readonly id: string }[] {
  return pathIds.map((id) => ({ id }));
}

export function factExplicitName(fact: StoryFact): string | null {
  const name = fact.name?.trim();
  return name === undefined || name.length === 0 ? null : name;
}

/** A single story-wide text state needs no state-history surface. */
export function isSingleUnscopedTextFact(fact: StoryFact): boolean {
  return !isFactStateful(fact);
}

export function factEffectiveText(
  fact: StoryFact,
  pathIds: readonly string[] = [],
  projection: FactPathProjection = factPathProjection(fact, pathIds)
): string | null {
  return projection.resolution.kind === "active" ? factStateText(projection.resolution.state) : null;
}

export function factScopeLabel(
  fact: StoryFact,
  pathIds: readonly string[] = [],
  pathNodes: readonly { readonly id: string; readonly text?: string; readonly preview?: string }[] = [],
  projection: FactPathProjection = factPathProjection(fact, pathIds)
): string {
  const states = projection.states;
  const resolution = projection.resolution;
  if (isSingleUnscopedTextFact(fact)) return "—";
  const scopeLabel = (anchorPartId: string | undefined): string => {
    if (anchorPartId === undefined) return "story";
    const index = pathIds.indexOf(anchorPartId);
    const node = pathNodes.find(({ id }) => id === anchorPartId);
    const ordinal = index < 0 ? "part" : `¶${index + 1}`;
    const preview = (node?.text ?? node?.preview ?? "").split("\n", 1)[0]?.trim() ?? "";
    return preview.length === 0 ? ordinal : `${ordinal} ${preview}`;
  };
  if (resolution.kind === "off-path") {
    const scopedState = states.find(({ anchorPartId }) => anchorPartId !== undefined);
    return `⊘ ${scopeLabel(scopedState?.anchorPartId)}`;
  }
  const index = states.findIndex(({ id }) => id === resolution.state.id);
  if (resolution.kind === "ended") {
    return `✕ ${scopeLabel(resolution.state.anchorPartId)}`;
  }
  const ordinal = `${Math.max(0, index) + 1}/${states.length}`;
  return `st.${ordinal} · ${scopeLabel(resolution.state.anchorPartId)}`;
}

/** A display-only state row. The state itself remains the only text authority;
 * these fields only explain where the row sits relative to the current path. */
export interface FactDossierEntry {
  readonly state: FactState;
  readonly index: number;
  readonly anchorPartIndex: number | null;
  readonly anchorLabel: string;
  readonly lineName: string | null;
  readonly onCurrentPath: boolean;
  readonly effective: boolean;
}

export function factDossierEntries(
  fact: StoryFact,
  payload: StoryPayload,
  projection: FactPathProjection = factPathProjection(fact, payload.path.map(({ id }) => id))
): FactDossierEntry[] {
  const pathIds = payload.path.map(({ id }) => id);
  const resolved = projection.resolution;
  return projection.states.map((state, index) => {
    const anchorPartIndex = state.anchorPartId === undefined
      ? null
      : pathIds.indexOf(state.anchorPartId);
    const pathIndex = anchorPartIndex ?? -1;
    const onCurrentPath = state.anchorPartId === undefined || pathIndex >= 0;
    const line = state.anchorPartId === undefined || onCurrentPath
      ? null
      : factStateLineName(payload, state.anchorPartId);
    return {
      state,
      index,
      anchorPartIndex: pathIndex < 0 ? null : pathIndex,
      anchorLabel: state.anchorPartId === undefined
        ? "start"
        : onCurrentPath
          ? `◆ ¶${pathIndex + 1}`
          : `◆ ${line ?? "another line"}`,
      lineName: line,
      onCurrentPath,
      effective: (resolved.kind === "active" || resolved.kind === "ended")
        && resolved.state.id === state.id
    };
  });
}

/** Search carries a state id, not a path. Resolve that id into writer-facing
 * ordinal and line context when the Facts overlay opens from a hit. */
export function factSearchHitContext(
  fact: StoryFact,
  stateId: string,
  payload: StoryPayload,
  projection: FactPathProjection = factPathProjection(fact, payload.path.map(({ id }) => id))
): string | null {
  const entry = factDossierEntries(fact, payload, projection).find(({ state }) => state.id === stateId);
  if (entry === undefined) return null;
  const stateLabel = `st.${entry.index + 1}`;
  if (entry.state.anchorPartId === undefined) return `search hit · ${stateLabel} · everywhere`;
  if (entry.onCurrentPath) return `search hit · ${stateLabel} · this line ${entry.anchorLabel}`;
  return `search hit · ${stateLabel} · elsewhere · ${entry.lineName ?? "another line"}`;
}

/** The compact note used in a row whose resolver has no state on this line.
 * It names the state and its line instead of showing misleading prose. */
export function factOffPathNote(
  fact: StoryFact,
  payload: StoryPayload,
  projection: FactPathProjection = factPathProjection(fact, payload.path.map(({ id }) => id))
): string {
  const entry = factDossierEntries(fact, payload, projection).find(({ onCurrentPath }) => !onCurrentPath);
  if (entry === undefined) return "other line · no state here";
  const stateKind = isFactEndState(entry.state) ? "ended" : `st.${entry.index + 1}`;
  return `other line · ${stateKind} · ${entry.lineName ?? "another line"}`;
}

function factStateLineName(payload: StoryPayload, anchorPartId: string): string | null {
  if (!payload.nodes.some(({ id }) => id === anchorPartId)) return null;
  return lineName(payload, rememberedLeafId(payload, anchorPartId));
}

export interface FactStateDiff {
  readonly fromIndex: number;
  readonly toIndex: number;
  readonly from: FactState;
  readonly to: FactState;
  readonly oldText: string;
  readonly newText: string;
  readonly added: string[];
  readonly omitted: string[];
}

/** Derive the apparatus text only when the dossier asks for it. Nothing from
 * this result is persisted or sent across a request boundary. */
export function factStateDiff(
  fact: StoryFact,
  toIndex: number
): FactStateDiff | null {
  const states = canonicalFactStates(fact);
  if (toIndex <= 0 || toIndex >= states.length) return null;
  const from = states[toIndex - 1]!;
  const to = states[toIndex]!;
  const oldText = factStateDisplayText(from);
  const newText = factStateDisplayText(to);
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  return {
    fromIndex: toIndex - 1,
    toIndex,
    from,
    to,
    oldText,
    newText,
    added: unmatchedLines(newLines, oldLines),
    omitted: unmatchedLines(oldLines, newLines)
  };
}

function factStateDisplayText(state: FactState): string {
  return isFactEndState(state) ? "✕ ended here" : state.text;
}

function unmatchedLines(candidate: readonly string[], baseline: readonly string[]): string[] {
  const remaining = [...baseline];
  const unmatched: string[] = [];
  for (const line of candidate) {
    const index = remaining.indexOf(line);
    if (index < 0) unmatched.push(line);
    else remaining.splice(index, 1);
  }
  return unmatched;
}

/** Storytavern's original Fact tag presets, in its slider order. */
export const DEFAULT_FACT_TAGS = ["people", "places", "rules", "items"] as const;

export function factTags(facts: readonly StoryFact[]): Array<string | null> {
  const tags = [...new Set(facts.map((fact) => fact.tag).filter((tag): tag is string => tag !== null && tag.length > 0))]
    .sort((left, right) => left.localeCompare(right));
  return [null, ...tags];
}

/** Presets first, then saved custom tags. The active unsaved tag remains in
 *  the slider until the writer saves or replaces it. */
export function factTagPresets(
  facts: readonly StoryFact[],
  active: string | null = null
): Array<string | null> {
  const custom = facts
    .map((fact) => fact.tag)
    .filter(reusableFactTag);
  return [
    null,
    ...new Set([
      ...DEFAULT_FACT_TAGS,
      ...custom,
      ...(reusableFactTag(active) ? [active] : [])
    ])
  ];
}

export function factRows(
  facts: readonly StoryFact[],
  tag: string | null,
  query: string,
  pathIds: readonly string[] = [],
  scope: FactScopeFilter = "everywhere"
): StoryFact[] {
  const tagged = (tag === null ? [...facts] : facts.filter((fact) => fact.tag === tag))
    .filter((fact) => factMatchesScope(fact, scope, pathIds));
  return fuzzyFilter(tagged, query, (fact) => {
    const text = factStates(fact)
      .map((state) => factStateText(state) ?? "")
      .join(" ");
    return `${factExplicitName(fact) ?? ""} ${fact.tag ?? ""} ${text}`;
  });
}

export function boundedFactCursor(cursor: number, length: number): number {
  return length === 0 ? 0 : Math.max(0, Math.min(cursor, length - 1));
}

export interface FactSelection {
  chip: number;
  cursor: number;
  selectedTag: string | null;
}

export function boundedFactSelection(
  facts: readonly StoryFact[],
  selection: FactSelection,
  query: string,
  pathIds: readonly string[] = [],
  scope: FactScopeFilter = "everywhere"
): FactSelection {
  const tags = factTags(facts);
  const retainedChip = selection.selectedTag === null ? 0 : tags.indexOf(selection.selectedTag);
  const chip = retainedChip < 0 ? 0 : retainedChip;
  const selectedTag = tags[chip] ?? null;
  const rows = factRows(facts, selectedTag, query, pathIds, scope);
  return { chip, selectedTag, cursor: boundedFactCursor(selection.cursor, rows.length) };
}

export function factName(
  fact: StoryFact,
  pathIds: readonly string[] = [],
  projection: FactPathProjection = factPathProjection(fact, pathIds)
): string {
  const explicit = factExplicitName(fact);
  if (explicit !== null) return explicit;
  const text = projection.displayText;
  return text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "Untitled fact";
}

/** Named facts use their explicit Name as title and show the full state text
 * as the one-line body on read-only surfaces. */
export function factBody(
  fact: StoryFact,
  pathIds: readonly string[] = [],
  projection: FactPathProjection = factPathProjection(fact, pathIds)
): string {
  const text = projection.displayText;
  if (factExplicitName(fact) !== null) return text.replace(/\s+/g, " ").trim();
  const lines = text.split("\n");
  const nameIndex = lines.findIndex((line) => line.trim().length > 0);
  if (nameIndex < 0) return "";
  return lines.slice(nameIndex + 1).join(" ").replace(/\s+/g, " ").trim();
}

/** Path scope takes precedence over request activation. A keyed miss remains
 * keyed when its effective state is on the current path. */
export function factStatusForPath(
  fact: StoryFact,
  status: FactRequestStatus,
  pathIds: readonly string[] = [],
  projection: FactPathProjection = factPathProjection(fact, pathIds)
): FactRequestStatus {
  const states = projection.states;
  if (states.length <= 1
    && states[0]?.anchorPartId === undefined
    && (states[0] === undefined || !isFactEndState(states[0]))) return status;
  const resolution = projection.resolution;
  if (resolution.kind === "off-path") return { kind: "off-path" };
  if (resolution.kind === "ended") return { kind: "ended" };
  return status;
}

/** One cell that says "this Fact sheds first" or "this Fact resists shedding"
 *  — the two priority states worth a glyph. `normal`, the common case, is
 *  blank so it never competes with the marker it sits beside. */
export function factPriorityGlyph(priority: StoryFact["priority"]): string {
  const effective = priority ?? "normal";
  return effective === "low" ? "↓" : effective === "high" ? "↑" : "";
}

function reusableFactTag(tag: string | null): tag is string {
  return tag !== null && tag.length > 0 && !/[\r\n\u2028\u2029]/u.test(tag);
}

/** What the next request would actually do with this Fact \u2014 the one thing
 *  `activeFactIds` used to conflate. A Fact whose keys matched but that the
 *  budget then shed is neither "sent" nor plain "not matched"; losing that
 *  third state is what let a shed Fact render identically to a dormant one
 *  (issue #281 review finding D). */
export type FactRequestStatus =
  | { readonly kind: "sent" }
  | { readonly kind: "not-matched" }
  | { readonly kind: "unevaluated" }
  | { readonly kind: "dropped"; readonly reason: FactDropReason }
  | { readonly kind: "off-path" }
  | { readonly kind: "ended" };

/** Classify every Fact in `facts` against the sets a request projection
 *  already computes: which Facts matched activation, and which of those the
 *  budget then dropped (`dropped` is always a subset of `matchedIds`). */
export function factRequestStatuses(
  facts: readonly StoryFact[],
  matchedIds: ReadonlySet<string>,
  dropped: readonly FactBudgetDrop[],
  unevaluatedIds: ReadonlySet<string> = new Set()
): ReadonlyMap<string, FactRequestStatus> {
  const droppedReasons = new Map(dropped.map((drop) => [drop.factId, drop.reason]));
  return new Map(facts.map((fact) => {
    const reason = droppedReasons.get(fact.id);
    const status: FactRequestStatus = reason !== undefined
      ? { kind: "dropped", reason }
      : matchedIds.has(fact.id) ? { kind: "sent" }
        : unevaluatedIds.has(fact.id) ? { kind: "unevaluated" } : { kind: "not-matched" };
    return [fact.id, status];
  }));
}

/** One glyph, one word, and the role to paint them with \u2014 the single place
 *  that decides how a Fact's request status reads, shared by the Facts
 *  panel and the side rail so the two surfaces cannot say different things
 *  about the same Fact (see tui/src/screens/facts-panel.ts and
 *  tui/src/screens/story/facts-rail.ts). */
export interface FactStatusDisplay {
  readonly glyph: string;
  readonly word: string;
  readonly emphasis: DisplayRole;
}

export function factStatusDisplay(
  activation: FactActivation,
  status: FactRequestStatus,
  trace?: FactActivationTrace
): FactStatusDisplay {
  if (status.kind === "off-path") {
    return { glyph: "\u2298", word: "off-path", emphasis: "chrome" };
  }
  if (status.kind === "ended") {
    return { glyph: "\u2715", word: "ended", emphasis: "context warning" };
  }
  if (activation === "always") {
    // An `always` Fact has no "not matched" state \u2014 it always matches by
    // definition \u2014 so the only thing worth marking is a shed one.
    return status.kind === "dropped"
      ? { glyph: "\u2715", word: "always", emphasis: "context warning" }
      : { glyph: "", word: "always", emphasis: "focus / accent" };
  }
  switch (status.kind) {
    case "sent": return { glyph: "\u2713", word: trace?.round && trace.round > 0 ? "chain" : trace?.kind === "regex" ? "regex" : "keyed", emphasis: "focus / accent" };
    case "dropped": return { glyph: "\u2715", word: "keyed", emphasis: "context warning" };
    case "unevaluated": return { glyph: "\u26a0", word: "keyed", emphasis: "context warning" };
    case "not-matched": return { glyph: "\u00b7", word: "keyed", emphasis: "chrome" };
  }
}

/** Fidelity-Report style (see shared/fidelity.ts): a short count-led clause
 * naming what changed, reusing `countNoun` rather than inventing a second
 * "N things happened" vocabulary. Mixed reasons name whichever shed the most
 * Facts. Shared by the context meter (a pre-flight guess) and a toast after a
 * real generation (what admission actually shed), so the two say it the same
 * way \u2014 see tui/src/screens/story/context-meter.ts and
 * tui/src/generation-action.ts. */
export function factDropNotice(dropped: readonly FactBudgetDrop[]): string | null {
  if (dropped.length === 0) return null;
  const counts = new Map<FactDropReason, number>();
  for (const drop of dropped) counts.set(drop.reason, (counts.get(drop.reason) ?? 0) + 1);
  const [dominantReason] = [...counts.entries()].sort((left, right) => right[1] - left[1])[0]!;
  return `${dropped.length} ${countNoun(dropped.length, "fact")} dropped \u00b7 ${dropReasonLabel(dominantReason)}`;
}

/** Kept short: worst case is a 3-digit count (MAX_FACTS=128) plus this label,
 *  and the rail's context-meter use still has to fit its narrow content width.
 *
 * "priority" is model-context-window pressure — the reason
 * shared/fact-admission.ts's shed loop reports (see
 * shared/fact-budget.ts's `spaceDropReason`). It does not mean the dropped
 * Fact was ranked "low": a `keyed` Fact is droppable under window pressure at
 * any priority (see `isDroppable`), so a tight window can drop one ranked
 * `high`. Calling that "low priority" told the writer something false about
 * their own Fact (issue #281 review finding J) — "over window" states the
 * real cause without needing the Fact's priority alongside it, and stays the
 * same short shape as its two siblings. */
function dropReasonLabel(reason: FactDropReason): string {
  switch (reason) {
    case "fact-budget": return "over its cap";
    case "total-budget": return "over budget";
    case "priority": return "over window";
    default: return assertNeverDropReason(reason);
  }
}

function assertNeverDropReason(value: never): never {
  throw new Error(`Unknown Fact drop reason: ${String(value)}`);
}
