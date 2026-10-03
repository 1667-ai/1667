import type { StoryFact, StoryPayload } from "./types.js";
import {
  canonicalFactStates,
  factStateText,
  firstFactText,
  isFactStateful,
  isFactEndState,
  resolveFactState,
  type FactState,
  type FactStateResolution
} from "./fact-state.js";
import { lineName, rememberedLeafId } from "./story-model.js";
import { fuzzyFilter } from "./fuzzy.js";

/** The pure Fact view helpers the TUI and the web UI share: scope, labels,
 * state dossier, tags, and the filtered row list. */

/** Shared state access. The TUI only adds path-id convenience and labels. */
export const factStates = canonicalFactStates;
export { canonicalFactStates, factStateText, resolveFactState } from "./fact-state.js";

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

