import type { FactActivation } from "../../shared/fact-metadata.js";
import type { FactActivationTrace } from "../../shared/fact-activation.js";
import type { FactBudgetDrop, FactDropReason } from "../../shared/fact-budget.js";
import { countNoun } from "../../shared/fidelity.js";
import type { StoryFact } from "../../shared/types.js";
import { isFactEndState } from "../../shared/fact-state.js";
import { factPathProjection, type FactPathProjection } from "../../shared/fact-view.js";
import type { DisplayRole } from "./screens/story/frame.js";

// The pure Fact view helpers live in `shared/` (the web UI uses them too).
export * from "../../shared/fact-view.js";

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
