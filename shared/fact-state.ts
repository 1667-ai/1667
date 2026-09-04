import type { StoryFact } from "./types.js";
import { unicodeScalarLength } from "./unicode.js";
import { MAX_FACT_STATES, MAX_FACT_TEXT_CHARS } from "./types.js";

/** Total eager text a Fact may carry across all of its text states. End
 * States contribute zero. Each state still has the ordinary per-state limit.
 */
export function factStatesTextLength(states: readonly FactState[]): number {
  return states.reduce(
    (total, state) => total + (isFactEndState(state) ? 0 : unicodeScalarLength(state.text)),
    0
  );
}

export function factStatesTextWithinLimit(states: readonly FactState[]): boolean {
  let total = 0;
  for (const state of states) {
    if (isFactEndState(state)) continue;
    const remaining = MAX_FACT_TEXT_CHARS - total;
    total += unicodeScalarLength(state.text, remaining);
    if (total > MAX_FACT_TEXT_CHARS) return false;
  }
  return true;
}

/** One canonical Fact snapshot. An absent `anchorPartId` means that the
 * snapshot applies from the beginning of the story. */
export interface FactTextState {
  readonly id: string;
  readonly anchorPartId?: string;
  readonly text: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A tombstone snapshot. It has no text revision and ends the Fact at its
 * anchor, inclusive. */
export interface FactEndState {
  readonly id: string;
  readonly anchorPartId?: string;
  readonly ends: true;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type FactState = FactTextState | FactEndState;

export function isFactEndState(state: FactState): state is FactEndState {
  return "ends" in state && state.ends === true;
}

/** A Fact needs state-history chrome unless it has exactly one story-wide text
 * state. Branch scope, an End State, and multiple snapshots need the state
 * editor surface. */
export function isFactStateful(
  fact: { readonly states: readonly FactState[] }
): boolean {
  const states = canonicalFactStates(fact);
  return states.length !== 1
    || states.some((state) => state.anchorPartId !== undefined || isFactEndState(state));
}

export function factStateText(state: FactState): string | null {
  return isFactEndState(state) ? null : state.text;
}

/** The state selected by the request path, including an end-state result.
 * `off-path` means no anchor on the path; `ended` means an End State won. */
export type FactStateResolution =
  | { readonly kind: "active"; readonly state: FactTextState }
  | { readonly kind: "ended"; readonly state: FactEndState }
  | { readonly kind: "off-path" };

/** Resolve one Fact without using manifest/document order. A state anchored on
 * a path part applies to that part and all descendants. The deepest matching
 * anchor wins; one unanchored state is the depth-zero fallback. */
export function resolveFactState(
  fact: Pick<StoryFact, "states">,
  requestPath: readonly { readonly id: string }[]
): FactStateResolution {
  const positions = new Map(requestPath.map((part, index) => [part.id, index] as const));
  return resolveFactStateAtPathPosition(fact, positions, requestPath.length - 1);
}

/** Resolve a Fact against one position in a known path. The caller can build
 * the full path index once and advance the prefix boundary for each part.
 * This preserves `resolveFactState` semantics without rebuilding a Map for
 * every Fact and prefix. */
export function resolveFactStateAtPathPosition(
  fact: Pick<StoryFact, "states">,
  pathPositions: ReadonlyMap<string, number>,
  pathPosition: number
): FactStateResolution {
  const states = canonicalFactStates(fact);
  let selected: FactState | undefined;
  let selectedDepth = -1;
  for (const state of states) {
    const anchorPosition = state.anchorPartId === undefined
      ? undefined
      : pathPositions.get(state.anchorPartId);
    const depth = state.anchorPartId === undefined
      ? 0
      : anchorPosition === undefined || anchorPosition > pathPosition
        ? -1
        : anchorPosition + 1;
    if (depth < 0 || depth <= selectedDepth) continue;
    selected = state;
    selectedDepth = depth;
  }
  if (selected === undefined) return { kind: "off-path" };
  return isFactEndState(selected)
    ? { kind: "ended", state: selected }
    : { kind: "active", state: selected };
}

/** An effective Fact view has exactly one text body for consumers that build a
 * request. It is a projection, not a second persisted authority. */
export type EffectiveStoryFact = Omit<StoryFact, "states"> & {
  readonly text: string;
  readonly stateId: string;
  readonly state: FactTextState;
};

/** Project one already-resolved text state without resolving the Fact again. */
export function effectiveFactFromState(
  fact: StoryFact,
  state: FactTextState
): EffectiveStoryFact {
  const { states: _states, ...metadata } = fact;
  return {
    ...metadata,
    text: state.text,
    stateId: state.id,
    state
  };
}

export function effectiveFactAtPath(
  fact: StoryFact,
  requestPath: readonly { readonly id: string }[]
): EffectiveStoryFact | null {
  const resolved = resolveFactState(fact, requestPath);
  if (resolved.kind !== "active") return null;
  return effectiveFactFromState(fact, resolved.state);
}

/** Return the canonical state list. Storage adapters lift legacy manifests
 * before exposing a Story. */
export function canonicalFactStates(
  fact: { readonly states: readonly FactState[] }
): readonly FactState[] {
  return fact.states;
}

/** True when the states still have the exact shape lifted from a flat
 * predecessor Fact. This is the only state shape that a one-text export can
 * carry without losing branch scope or state history. */
export function isLegacyFactStateShape(
  fact: Pick<StoryFact, "id" | "createdAt" | "updatedAt" | "states">
): boolean {
  const states = canonicalFactStates(fact);
  const state = states[0];
  return states.length === 1
    && state !== undefined
    && state.id === fact.id
    && state.anchorPartId === undefined
    && !isFactEndState(state)
    && state.createdAt === fact.createdAt
    && state.updatedAt === fact.updatedAt;
}

/** State text for compatibility surfaces that do not carry a request path.
 * New request paths should always use `effectiveFactAtPath`. */
export function firstFactText(fact: StoryFact | EffectiveStoryFact): string {
  if (!("states" in fact)) return fact.text;
  const state = canonicalFactStates(fact).find(
    (candidate): candidate is FactTextState => !isFactEndState(candidate)
  );
  return state?.text ?? "";
}

/** Validate identity and anchor invariants shared by format and mutation
 * boundaries. Anchor existence and summary rejection need the story tree and
 * therefore remain in the server parser. */
export function validateFactStates(states: readonly FactState[], label = "Fact states"): void {
  if (states.length === 0) throw new Error(`${label} must not be empty`);
  if (states.length > MAX_FACT_STATES) {
    throw new Error(`${label} exceeds the ${MAX_FACT_STATES}-state limit`);
  }
  const ids = new Set<string>();
  const anchors = new Set<string | undefined>();
  for (const state of states) {
    if (ids.has(state.id)) throw new Error(`${label} has duplicate state id: ${state.id}`);
    ids.add(state.id);
    if (anchors.has(state.anchorPartId)) {
      throw new Error(`${label} has duplicate state anchors`);
    }
    anchors.add(state.anchorPartId);
    if (isFactEndState(state)) continue;
    if (typeof state.text !== "string") throw new Error(`${label} text must be a string`);
  }
  if (states.filter((state) => state.anchorPartId === undefined).length > 1) {
    throw new Error(`${label} has more than one unanchored state`);
  }
}

/** Compare a state value while ignoring mutation timestamps. Used by durable
 * replay to prove that a deterministic state id already applied. */
export function sameFactStateValue(left: FactState, right: FactState): boolean {
  if (left.id !== right.id || left.anchorPartId !== right.anchorPartId) return false;
  if (isFactEndState(left) || isFactEndState(right)) return isFactEndState(left) && isFactEndState(right);
  return !isFactEndState(right) && left.text === right.text;
}
