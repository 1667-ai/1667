import type { StoryFact } from "../../shared/types.js";
import { graphemeCells } from "./cell-width.js";
import { stripGuidance } from "./editor.js";
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

/** Parse a Fact editor document. Returns null when a `tag-json:` header is
 *  present but not valid JSON string encoding — callers must not treat that as
 *  tag deletion. A blank `tag:` header still means no tag. */
export function parseFactEditor(value: string): { tag: string | null; text: string } | null {
  const stripped = stripGuidance(value);
  const lines = stripped.split("\n");
  // Only the blank line immediately after the header separates tag from body.
  // A later paragraph break must never promote body lines into the tag.
  const separator = lines.length > 1 && lines[1]!.length === 0 ? 1 : -1;
  const encoded = /^tag-json:\s*(.*)$/i.exec(lines[0] ?? "");
  if (encoded !== null) {
    // Structured headers must decode cleanly. Malformed JSON never becomes a
    // blank tag (that would delete a persisted multiline tag on save).
    let parsed: unknown;
    try {
      parsed = JSON.parse(encoded[1]!);
    } catch {
      return null;
    }
    if (typeof parsed !== "string") return null;
    const tag = parsed.trim().length > 0 ? parsed : null;
    return { tag, text: factEditorBody(lines, separator) };
  }
  const match = /^tag:\s*([\s\S]*)$/i.exec(lines[0] ?? "");
  if (match === null) return { tag: null, text: stripped };
  // Header is always the first line. Continuation lines before a distant blank
  // separator used to become the tag; that silently corrupted multi-paragraph
  // bodies when the writer deleted the required blank after the header.
  const tag = match[1]!.trim() || null;
  return { tag, text: factEditorBody(lines, separator) };
}

export function serializeFactEditor(fact: StoryFact | null): string {
  if (fact === null) return "tag: \n\n";
  return `${serializeFactTagHeader(fact.tag)}\n\n${fact.text}`;
}

export function factEditorTag(value: string): string | null {
  return parseFactEditor(value)?.tag ?? null;
}

/** Grapheme range of the editable value in the `tag:` header. */
export function factEditorTagRange(value: string): { start: number; end: number } | null {
  const end = factEditorHeaderEnd(value);
  const header = value.slice(0, end);
  const match = /^(tag(?:-json)?:\s*)([\s\S]*)$/i.exec(header);
  if (match === null) return null;
  const start = graphemeCells(match[1]!).length;
  return { start, end: start + graphemeCells(match[2]!).length };
}

export function factEditorTagLineRange(value: string): { start: number; end: number } | null {
  const header = value.slice(0, factEditorHeaderEnd(value));
  return /^tag(?:-json)?:/i.test(header)
    ? { start: 0, end: graphemeCells(header).length }
    : null;
}

/** True when cursor and effective anchor both lie inside the editable tag value. */
export function factEditorSelectionInsideTag(
  value: string,
  cursor: number | null,
  anchor: number | null
): boolean {
  const range = factEditorTagRange(value);
  const effectiveAnchor = anchor ?? cursor;
  if (range === null || cursor === null || effectiveAnchor === null) return false;
  return cursor >= range.start && cursor <= range.end
    && effectiveAnchor >= range.start && effectiveAnchor <= range.end;
}

export function serializeFactTagHeader(tag: string | null): string {
  if (tag === null) return "tag: ";
  return /[\r\n\u2028\u2029]/u.test(tag)
    ? `tag-json: ${JSON.stringify(tag)
      .replace(/\u2028/gu, "\\u2028")
      .replace(/\u2029/gu, "\\u2029")}`
    : `tag: ${tag}`;
}

function reusableFactTag(tag: string | null): tag is string {
  return tag !== null && tag.length > 0 && !/[\r\n\u2028\u2029]/u.test(tag);
}

function factEditorHeaderEnd(value: string): number {
  const firstLine = value.indexOf("\n");
  if (firstLine < 0) return value.length;
  // Canonical form: blank separator immediately after the header line.
  // Legacy one-line documents keep the first line as the header only.
  return firstLine;
}

function factEditorBody(lines: readonly string[], separator: number): string {
  // Canonical: body after the blank line. Legacy: body after the header line,
  // including any later paragraph breaks that must stay in the body.
  return lines.slice(separator < 0 ? 1 : separator + 1).join("\n").replace(/^\n+/, "");
}
