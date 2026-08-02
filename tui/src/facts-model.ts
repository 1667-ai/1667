import type { StoryFact } from "../../shared/types.js";
import { fuzzyFilter } from "./fuzzy.js";

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
