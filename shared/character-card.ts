import {
  MAX_FACTS,
  MAX_FACT_TEXT_CHARS,
  MAX_IMPORT_BYTES,
  isRecord,
  type FactInput
} from "./types.js";
import {
  hasPngSignature,
  readPngTextChunk
} from "./png-text-chunk.js";
import { countNoun, lossLines, type LossPhrases } from "./fidelity.js";

export const MAX_CHARACTER_CARD_JSON_BYTES = 1_000_000;
export const MAX_CHARACTER_CARD_NAME_CHARS = 200;

export interface CharacterCardCore {
  version: 1 | 2 | 3;
  name: string;
  description: string;
  personality: string;
  scenario: string;
  /** `data.character_book`, present on a V2 or V3 card that carries one. Read
   * it with `entriesFromCharacterBook` in `character-book.js`; this module
   * only carries the four core fields through to a Fact. */
  characterBook?: unknown;
  /** Fidelity Report lines for V3 fields this converter does not import.
   * Empty for a V1 or V2 card, which has no such fields to name. */
  readonly fidelity: readonly string[];
}

export interface CharacterCardSections {
  name: string;
  description?: string;
  personality?: string;
  scenario?: string;
}

interface NamedSection {
  label: string;
  text: string;
}

const MACROS = /\{\{(char|user)\}\}/gi;
const MAX_COMBINED_FACT_TEXT_CHARS = MAX_FACTS * MAX_FACT_TEXT_CHARS;

export function parseCharacterCard(bytes: Uint8Array): CharacterCardCore {
  if (bytes.byteLength === 0) throw new Error("Character card file is empty.");
  if (bytes.byteLength > MAX_IMPORT_BYTES) {
    throw new Error(`Character card is larger than the ${MAX_IMPORT_BYTES / 1_000_000} MB import limit.`);
  }
  if (hasPngSignature(bytes)) return parsePngCard(bytes);
  rejectUnsupportedContainer(bytes);
  return parseJsonCard(bytes);
}

export function factsFromCharacterCard(source: CharacterCardSections): FactInput[] {
  const name = characterName(source.name, "Character name cannot be empty.");

  const sections = [
    selectedSection("Description", source.description),
    selectedSection("Personality", source.personality),
    selectedSection("Scenario", source.scenario)
  ].filter((section): section is NamedSection => section !== null);
  if (sections.length === 0) throw new Error("Select at least one non-empty character field.");
  let combinedLength = 0;
  for (const section of sections) {
    combinedLength += expandedMacroLength(section.text, name);
    if (combinedLength > MAX_COMBINED_FACT_TEXT_CHARS) {
      throw new Error(`Selected character text needs more than ${MAX_FACTS} facts; shorten it before importing.`);
    }
  }
  const expandedSections = sections.map((section) => ({
    ...section,
    text: section.text.replace(MACROS, (_match, kind: string) =>
      kind.toLowerCase() === "char" ? name : "the protagonist")
  }));

  const pieces = expandedSections.flatMap((section) => splitSection(name, section));
  const packed: NamedSection[][] = [];
  let current: NamedSection[] = [];
  for (const piece of pieces) {
    const candidate = [...current, piece];
    if (current.length > 0 && renderFact(name, candidate).length > MAX_FACT_TEXT_CHARS) {
      packed.push(current);
      current = [piece];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) packed.push(current);
  if (packed.length > MAX_FACTS) {
    throw new Error(`Selected character text needs more than ${MAX_FACTS} facts; shorten it before importing.`);
  }
  return packed.map((group) => ({ tag: "Character", text: renderFact(name, group) }));
}

function parsePngCard(bytes: Uint8Array): CharacterCardCore {
  // A V3 PNG usually carries both chunks: `ccv3` with the V3 payload and
  // `chara` with a V2-shaped fallback for older readers. Prefer `ccv3` when
  // the chunk is present at all; fall back to `chara` only when it is not.
  const v3Text = readPngTextChunk(bytes, "ccv3");
  if (v3Text !== null) return parseJsonCardText(v3Text);
  const jsonText = readPngTextChunk(bytes, "chara");
  if (jsonText === null) {
    throw new Error("No character data found. This may be an ordinary image or its card metadata was stripped.");
  }
  return parseJsonCardText(jsonText);
}

function parseJsonCard(bytes: Uint8Array): CharacterCardCore {
  if (bytes.byteLength > MAX_CHARACTER_CARD_JSON_BYTES) {
    throw new Error("Character card data exceeds the 1 MB limit.");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Character card data is not valid UTF-8.");
  }
  return parseJsonCardText(text);
}

function parseJsonCardText(text: string): CharacterCardCore {
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("Character card data is not valid JSON.");
  }
  return normalizeCard(value);
}

/** A V1 card names its fields at the root; a V2 card wraps them in `data`.
 *
 * Matches the shape `normalizeCard` accepts: a name plus one of description,
 * personality, or scenario, or a `chara_card` spec. The one place that decides
 * whether a JSON value looks like a character card, so a dispatcher elsewhere
 * never re-derives this rule and drifts from what actually parses. */
export function looksLikeCharacterCard(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value.spec === "string" && value.spec.startsWith("chara_card")) return true;
  const root = isRecord(value.data) ? value.data : value;
  return typeof root.name === "string"
    && (typeof root.description === "string"
      || typeof root.personality === "string"
      || typeof root.scenario === "string");
}

function normalizeCard(value: unknown): CharacterCardCore {
  if (!isRecord(value)) throw new Error("Character card JSON must be an object.");
  let version: 1 | 2 | 3;
  let data: Record<string, unknown>;
  if (value.spec === undefined) {
    version = 1;
    data = value;
  } else if (value.spec === "chara_card_v2") {
    version = 2;
    if (!isRecord(value.data)) throw new Error("Character Card V2 is missing its data object.");
    if (value.spec_version !== "2.0") {
      throw new Error("Unsupported Character Card V2 spec version; expected 2.0.");
    }
    data = value.data;
  } else if (value.spec === "chara_card_v3") {
    version = 3;
    if (!isRecord(value.data)) throw new Error("Character Card V3 is missing its data object.");
    validateV3SpecVersion(value.spec_version);
    data = value.data;
  } else {
    throw new Error("Unsupported character card specification.");
  }

  const name = characterName(coreString(data, "name"), "Character card is missing a name.");
  const description = coreString(data, "description");
  const personality = coreString(data, "personality");
  const scenario = coreString(data, "scenario");
  validateText(description, "Description");
  validateText(personality, "Personality");
  validateText(scenario, "Scenario");
  if (![description, personality, scenario].some((entry) => entry.trim().length > 0)) {
    throw new Error("Character card has no description, personality, or scenario to import.");
  }
  return {
    version,
    name,
    description,
    personality,
    scenario,
    // `character_book` is a V2 and V3 field; a V1 card has no `data` wrapper
    // and no such concept. Its absence is meaningful, so it stays optional
    // rather than joining `fidelity` below.
    ...(version !== 1 && data.character_book !== undefined ? { characterBook: data.character_book } : {}),
    fidelity: version === 3 ? ignoredV3Fields(data) : []
  };
}

/** `spec_version` for `chara_card_v3` is parsed as a float, per the spec's own
 * forward-compatibility rule. Accept any `3.x`; refuse anything else by name
 * rather than guess at a version 1667 has not seen. */
function validateV3SpecVersion(value: unknown): void {
  if (typeof value !== "string") {
    throw new Error("Character Card V3 is missing its spec_version.");
  }
  // parseFloat would take "3abc" as 3. A version is digits and dots, so the
  // shape is checked before the major number is read.
  const parsed = /^3(\.\d+)*$/u.test(value) ? Number.parseFloat(value) : Number.NaN;
  if (!Number.isFinite(parsed) || Math.floor(parsed) !== 3) {
    throw new Error(`Unsupported Character Card V3 spec version; expected a 3.x version, got "${value}".`);
  }
}

type IgnoredV3Field =
  | "greetings"
  | "examples"
  | "assets"
  | "creatorNotes"
  | "systemPrompt"
  | "postHistoryInstructions"
  | "characterVersion"
  | "tags"
  | "creator";

const IGNORED_V3_FIELD_PHRASES: LossPhrases<IgnoredV3Field> = {
  greetings: (count) => `${count} ${countNoun(count, "greeting")} not imported`,
  examples: () => "example messages not imported",
  assets: (count) => `${count} ${countNoun(count, "asset")} not imported`,
  creatorNotes: () => "creator notes not imported",
  systemPrompt: () => "system prompt not imported",
  postHistoryInstructions: () => "post-history instructions not imported",
  characterVersion: () => "character version not imported",
  tags: (count) => `${count} ${countNoun(count, "tag")} not imported`,
  creator: () => "creator not imported"
};

/** Name every V3 field this converter ignores, so the Fidelity Report is the
 * one place a writer learns what a V3 card carried that did not come across.
 * Counts what the card holds; a field that is absent or empty is not named. */
function ignoredV3Fields(data: Record<string, unknown>): readonly string[] {
  const present: IgnoredV3Field[] = [];
  const greetingCount = (nonEmptyString(data.first_mes) ? 1 : 0)
    + arrayLength(data.alternate_greetings)
    + arrayLength(data.group_only_greetings);
  for (let index = 0; index < greetingCount; index += 1) present.push("greetings");
  if (nonEmptyString(data.mes_example)) present.push("examples");
  for (let index = 0; index < arrayLength(data.assets); index += 1) present.push("assets");
  if (nonEmptyString(data.creator_notes)) present.push("creatorNotes");
  if (nonEmptyString(data.system_prompt)) present.push("systemPrompt");
  if (nonEmptyString(data.post_history_instructions)) present.push("postHistoryInstructions");
  if (nonEmptyString(data.character_version)) present.push("characterVersion");
  for (let index = 0; index < arrayLength(data.tags); index += 1) present.push("tags");
  if (nonEmptyString(data.creator)) present.push("creator");
  return lossLines(present, IGNORED_V3_FIELD_PHRASES);
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function coreString(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  if (value === undefined) return "";
  if (typeof value !== "string") throw new Error(`Character card field ${key} must be text.`);
  return value;
}

function selectedSection(label: string, value: string | undefined): NamedSection | null {
  if (value === undefined || value.trim().length === 0) return null;
  validateText(value, label);
  return { label, text: value.trim() };
}

function expandedMacroLength(text: string, name: string): number {
  let length = text.length;
  for (const match of text.matchAll(MACROS)) {
    length += (match[1]!.toLowerCase() === "char" ? name.length : "the protagonist".length) - match[0].length;
  }
  return length;
}

function splitSection(name: string, section: NamedSection): NamedSection[] {
  if (renderFact(name, [section]).length <= MAX_FACT_TEXT_CHARS) return [section];
  // Use the source length's digit count for a conservative fixed overhead. This
  // avoids an unstable split/count/re-split loop around 9/10 or 99/100 pieces.
  const digits = String(section.text.length).length;
  const placeholder = `${section.label} (${"9".repeat(digits)}/${"9".repeat(digits)})`;
  const maxText = MAX_FACT_TEXT_CHARS - renderFact(name, [{ label: placeholder, text: "" }]).length;
  if (maxText < 1) throw new Error("Character name and section label leave no room for fact text.");
  const chunks = splitText(section.text, maxText);
  return chunks.map((text, index) => ({
    label: `${section.label} (${index + 1}/${chunks.length})`,
    text
  }));
}

function splitText(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (text.length - start > maxLength) {
    const end = start + maxLength;
    const floor = start + Math.floor(maxLength / 2);
    let cut = lastBoundary(text, "\n\n", floor, end);
    if (cut === -1) cut = lastBoundary(text, "\n", floor, end);
    if (cut === -1) {
      cut = end;
      for (let index = end - 1; index >= floor; index -= 1) {
        if (/\s/u.test(text[index]!)) {
          cut = index + 1;
          break;
        }
      }
    }
    if (isHighSurrogate(text.charCodeAt(cut - 1)) && isLowSurrogate(text.charCodeAt(cut))) cut -= 1;
    chunks.push(text.slice(start, cut));
    start = cut;
  }
  chunks.push(text.slice(start));
  return chunks;
}

function lastBoundary(text: string, boundary: string, start: number, end: number): number {
  for (let index = end - boundary.length; index >= start; index -= 1) {
    if (text.startsWith(boundary, index)) return index + boundary.length;
  }
  return -1;
}

function renderFact(name: string, sections: readonly NamedSection[]): string {
  return [`Name: ${name}`, ...sections.map((section) => `${section.label}:\n${section.text}`)].join("\n\n");
}

function rejectUnsupportedContainer(bytes: Uint8Array): void {

  if (equalsAscii(bytes, 0, 4, "RIFF") && equalsAscii(bytes, 8, 12, "WEBP")) {
    throw new Error("Character card WebP files are not supported yet; export a V2 PNG or JSON card.");
  }
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && (
    (bytes[2] === 0x03 && bytes[3] === 0x04)
    || (bytes[2] === 0x05 && bytes[3] === 0x06)
    || (bytes[2] === 0x07 && bytes[3] === 0x08)
  )) {
    throw new Error("Character card archives such as CHARX are not supported yet; export a V2 PNG or JSON card.");
  }
}

function equalsAscii(bytes: Uint8Array, start: number, end: number, expected: string): boolean {
  if (end - start !== expected.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (bytes[start + index] !== expected.charCodeAt(index)) return false;
  }
  return true;
}

function validateText(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (isHighSurrogate(code)) {
      if (!isLowSurrogate(value.charCodeAt(index + 1))) throw new Error(`${label} contains invalid Unicode.`);
      index += 1;
    } else if (isLowSurrogate(code)) {
      throw new Error(`${label} contains invalid Unicode.`);
    }
  }
}

function characterName(value: string, emptyError: string): string {
  const name = value.trim();
  validateText(name, "Character name");
  if (name.length === 0) throw new Error(emptyError);
  if (/[\r\n\u2028\u2029]/u.test(name)) throw new Error("Character name must fit on one line.");
  if (name.length > MAX_CHARACTER_CARD_NAME_CHARS) {
    throw new Error(`Character name exceeds ${MAX_CHARACTER_CARD_NAME_CHARS} characters.`);
  }
  return name;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
