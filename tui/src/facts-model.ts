import type { FactActivation } from "../../shared/fact-activation.js";
import type { FactBudgetDrop, FactDropReason } from "../../shared/fact-budget.js";
import { countNoun } from "../../shared/fidelity.js";
import type { StoryFact } from "../../shared/types.js";
import { fuzzyFilter } from "./fuzzy.js";
import type { DisplayRole } from "./screens/story/frame.js";

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

export function factRows(facts: readonly StoryFact[], tag: string | null, query: string): StoryFact[] {
  const tagged = tag === null ? [...facts] : facts.filter((fact) => fact.tag === tag);
  return fuzzyFilter(tagged, query, (fact) => `${fact.text.split("\n", 1)[0] ?? ""} ${fact.tag ?? ""} ${fact.text}`);
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
  facts: readonly StoryFact[], selection: FactSelection, query: string
): FactSelection {
  const tags = factTags(facts);
  const retainedChip = selection.selectedTag === null ? 0 : tags.indexOf(selection.selectedTag);
  const chip = retainedChip < 0 ? 0 : retainedChip;
  const selectedTag = tags[chip] ?? null;
  const rows = factRows(facts, selectedTag, query);
  return { chip, selectedTag, cursor: boundedFactCursor(selection.cursor, rows.length) };
}

export function factName(fact: StoryFact): string {
  return fact.text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "Untitled fact";
}

/** Named facts use the first non-empty line as their title and the remaining
 * lines as the one-line body shown by read-only surfaces. */
export function factBody(fact: StoryFact): string {
  const lines = fact.text.split("\n");
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

/** What the next request would actually do with this Fact \u2014 the one thing
 *  `activeFactIds` used to conflate. A Fact whose keys matched but that the
 *  budget then shed is neither "sent" nor plain "not matched"; losing that
 *  third state is what let a shed Fact render identically to a dormant one
 *  (issue #281 review finding D). */
export type FactRequestStatus =
  | { readonly kind: "sent" }
  | { readonly kind: "not-matched" }
  | { readonly kind: "dropped"; readonly reason: FactDropReason };

/** Classify every Fact in `facts` against the sets a request projection
 *  already computes: which Facts matched activation, and which of those the
 *  budget then dropped (`dropped` is always a subset of `matchedIds`). */
export function factRequestStatuses(
  facts: readonly StoryFact[],
  matchedIds: ReadonlySet<string>,
  dropped: readonly FactBudgetDrop[]
): ReadonlyMap<string, FactRequestStatus> {
  const droppedReasons = new Map(dropped.map((drop) => [drop.factId, drop.reason]));
  return new Map(facts.map((fact) => {
    const reason = droppedReasons.get(fact.id);
    const status: FactRequestStatus = reason !== undefined
      ? { kind: "dropped", reason }
      : matchedIds.has(fact.id) ? { kind: "sent" } : { kind: "not-matched" };
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
  status: FactRequestStatus
): FactStatusDisplay {
  if (activation === "always") {
    // An `always` Fact has no "not matched" state \u2014 it always matches by
    // definition \u2014 so the only thing worth marking is a shed one.
    return status.kind === "dropped"
      ? { glyph: "\u2715", word: "always", emphasis: "context warning" }
      : { glyph: "", word: "always", emphasis: "focus / accent" };
  }
  switch (status.kind) {
    case "sent": return { glyph: "\u2713", word: "keyed", emphasis: "focus / accent" };
    case "dropped": return { glyph: "\u2715", word: "keyed", emphasis: "context warning" };
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
