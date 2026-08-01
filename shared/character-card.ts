import {
  MAX_FACTS,
  MAX_FACT_TEXT_CHARS,
  MAX_IMPORT_BYTES,
  type FactInput
} from "./types.js";
import {
  hasPngSignature,
  hasPngTextKeyword,
  readPngTextChunk
} from "./png-text-chunk.js";

export const MAX_CHARACTER_CARD_JSON_BYTES = 1_000_000;
export const MAX_CHARACTER_CARD_NAME_CHARS = 200;

export interface CharacterCardCore {
  version: 1 | 2;
  name: string;
  description: string;
  personality: string;
  scenario: string;
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

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MACROS = /\{\{(char|user)\}\}/gi;
const MAX_COMBINED_FACT_TEXT_CHARS = MAX_FACTS * MAX_FACT_TEXT_CHARS;
const textEncoder = new TextEncoder();

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

/** Exact UTF-8 size of the body sent by api.createFact for a card import. */
export function factImportRequestBytes(facts: readonly FactInput[]): number {
  return textEncoder.encode(JSON.stringify({ facts })).byteLength;
}

function parsePngCard(bytes: Uint8Array): CharacterCardCore {
  const jsonText = readPngTextChunk(bytes, "chara");
  if (jsonText === null) {
    if (hasPngTextKeyword(bytes, "ccv3")) {
      throw new Error("Character Card V3 PNGs are not supported yet; export a V2 PNG or JSON card.");
    }
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


function normalizeCard(value: unknown): CharacterCardCore {
  if (!isRecord(value)) throw new Error("Character card JSON must be an object.");
  let version: 1 | 2;
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
    throw new Error("Character Card V3 is not supported yet; export a V2 PNG or JSON card.");
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
  return { version, name, description, personality, scenario };
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

function decodeBase64(source: string): Uint8Array {
  const encoded = source.trim();
  const maxEncoded = Math.ceil(MAX_CHARACTER_CARD_JSON_BYTES / 3) * 4;
  if (encoded.length === 0 || encoded.length > maxEncoded || !BASE64.test(encoded)) {
    throw new Error("Character card PNG contains invalid or oversized Base64 metadata.");
  }
  let decoded: string;
  try {
    decoded = atob(encoded);
  } catch {
    throw new Error("Character card PNG contains invalid Base64 metadata.");
  }
  if (decoded.length > MAX_CHARACTER_CARD_JSON_BYTES) {
    throw new Error("Character card data exceeds the 1 MB limit.");
  }
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
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

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let result = "";
  for (let index = start; index < end; index += 1) {
    const byte = bytes[index]!;
    if (byte > 127) throw new Error("Character card PNG metadata is not valid ASCII.");
    result += String.fromCharCode(byte);
  }
  return result;
}

function findByte(bytes: Uint8Array, value: number, start: number, end: number): number {
  for (let index = start; index < end; index += 1) {
    if (bytes[index] === value) return index;
  }
  return -1;
}

function equalsAscii(bytes: Uint8Array, start: number, end: number, expected: string): boolean {
  if (end - start !== expected.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (bytes[start + index] !== expected.charCodeAt(index)) return false;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
