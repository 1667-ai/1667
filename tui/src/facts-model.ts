import type { StoryFact } from "../../shared/types.js";
import { stripGuidance } from "./editor.js";
import { fuzzyFilter } from "./fuzzy.js";

export function factTags(facts: readonly StoryFact[]): Array<string | null> {
  const tags = [...new Set(facts.map((fact) => fact.tag).filter((tag): tag is string => tag !== null && tag.length > 0))]
    .sort((left, right) => left.localeCompare(right));
  return [null, ...tags];
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

export function parseFactEditor(value: string): { tag: string | null; text: string } {
  const stripped = stripGuidance(value);
  const lines = stripped.split("\n");
  const match = /^tag:\s*(.*)$/i.exec(lines[0] ?? "");
  if (match === null) return { tag: null, text: stripped };
  return { tag: match[1]!.trim() || null, text: lines.slice(1).join("\n").replace(/^\n+/, "") };
}

export function serializeFactEditor(fact: StoryFact | null): string {
  if (fact === null) return "tag: \n\n";
  return fact.tag === null ? fact.text : `tag: ${fact.tag}\n${fact.text}`;
}
