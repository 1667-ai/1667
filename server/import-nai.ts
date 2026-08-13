import { ServiceError } from "./errors.js";
import {
  MAX_IMPORT_BYTES,
  MAX_PARTS,
  MAX_TOTAL_CHARS,
  totalImportedPartChars,
  type GenericImport,
  type ImportedPart
} from "./import-model.js";
import {
  MAX_NOVELAI_RECORDS,
  partsFromNovelAiDocument
} from "./import-nai-document.js";
import { alternatesFromNovelAiLegacyHistory } from "./import-nai-legacy-history.js";
import { splitLegacyStoryLines } from "./import-nai-legacy-lines.js";
import { parseJsonRejectingDuplicateKeys } from "./strict-json.js";
import {
  MAX_FACTS,
  MAX_FACT_TEXT_CHARS,
  MAX_STORED_TITLE_CHARS,
  type FactInput
} from "../shared/types.js";
import {
  MAX_AUTHORS_NOTE_CHARS,
  normalizeAuthorsNote
} from "../shared/authors-note.js";
import {
  factsFromLorebook,
  isSupportedNovelAiLorebookVersion
} from "../shared/novelai-lorebook.js";
import { factTextWithinLimit, truncateFactText } from "../shared/fact-limits.js";
import {
  hasUnpairedSurrogate,
  sliceUnicodeScalarPrefix,
  unicodeScalarLength
} from "../shared/unicode.js";

export { MAX_IMPORT_BYTES, MAX_PARTS, MAX_TOTAL_CHARS };
export { MAX_NOVELAI_RECORDS as MAX_RECORDS };

const FALLBACK_TITLE = "Imported NovelAI story";
export const MAX_NOVELAI_JSON_VALUES = MAX_NOVELAI_RECORDS * 10;

export interface NovelAiContainerImport {
  readonly story: GenericImport;
  readonly facts: readonly FactInput[];
  readonly authorsNote: string | null;
  readonly fidelity: readonly string[];
}

export function partsFromNovelAiStory(jsonText: string): NovelAiContainerImport {
  if (Buffer.byteLength(jsonText) > MAX_IMPORT_BYTES) {
    throw new ServiceError(413, "Request body too large");
  }
  if (jsonText.trim().length === 0) {
    throw new ServiceError(400, "Empty file");
  }

  let rawJson: unknown;
  try {
    rawJson = parseJsonRejectingDuplicateKeys(
      jsonText,
      "NovelAI story container",
      { maxValues: MAX_NOVELAI_JSON_VALUES }
    );
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError(400, "Malformed JSON");
  }

  if (!isRecord(rawJson)) {
    throw new ServiceError(400, "Malformed JSON structure");
  }
  if (rawJson.storyContainerVersion !== 1) {
    throw new ServiceError(400, "Unsupported storyContainerVersion");
  }
  if (rawJson.metadata !== undefined && !isRecord(rawJson.metadata)) {
    throw new ServiceError(400, "Malformed metadata object");
  }
  if (!isRecord(rawJson.content)) {
    throw new ServiceError(400, "Malformed content object");
  }

  const title = importTitle(rawJson.metadata?.title);
  const document = rawJson.content.document;
  let story: GenericImport;
  const fidelity: string[] = [];
  if (typeof document === "string" && document.length > 0) {
    const documentImport = partsFromNovelAiDocument(document);
    story = { title, parts: [...documentImport.parts] };
    fidelity.push(...documentImport.fidelity);
  } else if (document !== undefined && document !== "") {
    throw new ServiceError(400, "Malformed MessagePack document");
  } else {
    const legacy = parseLegacyStory(rawJson.content.story, title);
    const alternates = alternatesFromNovelAiLegacyHistory(rawJson.content.story, {
      parts: legacy.parts,
      room: MAX_PARTS - legacy.parts.length,
      charsRoom: MAX_TOTAL_CHARS - totalImportedPartChars(legacy.parts)
    });
    story = { title, parts: [...legacy.parts, ...alternates.parts] };
    fidelity.push(...alternates.fidelity);
  }

  const facts = extractFacts(rawJson.content.context, rawJson.content.lorebook, fidelity);
  const authorsNote = extractAuthorsNote(rawJson.content.context, fidelity);

  fidelity.push("generation settings omitted");

  return { story, facts, authorsNote, fidelity };
}

export function importTitle(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return FALLBACK_TITLE;
  }
  if (hasUnpairedSurrogate(value)) {
    throw new ServiceError(400, "Title contains invalid Unicode");
  }
  const normalized = value.normalize("NFC").replace(/[\r\n]+/g, " ").trim();
  return normalized.length === 0
    ? FALLBACK_TITLE
    : sliceUnicodeScalarPrefix(normalized, MAX_STORED_TITLE_CHARS);
}

export function extractFacts(
  contextRaw: unknown,
  lorebookRaw: unknown,
  fidelity: string[]
): readonly FactInput[] {
  let memoryFact: FactInput | null = null;
  const contextArray = Array.isArray(contextRaw) ? contextRaw : [];
  const memEntry = contextArray[0];
  if (isRecord(memEntry) && typeof memEntry.text === "string") {
    if (hasUnpairedSurrogate(memEntry.text)) {
      throw new ServiceError(400, "Memory contains invalid Unicode");
    }
    const normalized = memEntry.text.replace(/\r\n|\r|\u2028|\u2029/g, "\n");
    // Memory takes the same line-ending rule as a Lorebook entry, so it takes
    // the same notice. A Fact can hold CRLF or a Unicode separator exactly.
    if (normalized !== memEntry.text) {
      fidelity.push("memory changed to line feeds");
    }
    if (normalized.trim().length > 0) {
      let text = normalized;
      if (!factTextWithinLimit(text)) {
        text = truncateFactText(text);
        fidelity.push(`memory truncated to ${MAX_FACT_TEXT_CHARS.toLocaleString()} characters`);
      }
      memoryFact = { tag: "memory", text, activation: "always", keys: [] };
    }
  }

  const room = MAX_FACTS - (memoryFact !== null ? 1 : 0);
  let lorebookFacts: readonly FactInput[] = [];
  if (isRecord(lorebookRaw)) {
    // The prose is what the writer came for. A Lorebook the reader does not
    // know is worth a line in the report, not the loss of the manuscript, so
    // the embedded Lorebook degrades where a `.lorebook` file refuses.
    if (!isSupportedNovelAiLorebookVersion(lorebookRaw.lorebookVersion)) {
      fidelity.push(
        `lorebook version ${String(lorebookRaw.lorebookVersion ?? "missing")} not read`
      );
    } else {
      try {
        const lorebookImport = factsFromLorebook(lorebookRaw, room);
        lorebookFacts = lorebookImport.facts;
        fidelity.push(...lorebookImport.fidelity);
      } catch (error) {
        if (error instanceof ServiceError) throw error;
        throw new ServiceError(400, error instanceof Error ? error.message : String(error));
      }
    }
  }

  return memoryFact !== null ? [memoryFact, ...lorebookFacts] : lorebookFacts;
}

export function extractAuthorsNote(
  contextRaw: unknown,
  fidelity: string[]
): string | null {
  const contextArray = Array.isArray(contextRaw) ? contextRaw : [];
  const anEntry = contextArray[1];
  if (!isRecord(anEntry) || typeof anEntry.text !== "string") {
    return null;
  }
  if (hasUnpairedSurrogate(anEntry.text)) {
    throw new ServiceError(400, "Author's Note contains invalid Unicode");
  }
  const norm = normalizeAuthorsNote(anEntry.text);
  if (norm === null) return null;
  if (unicodeScalarLength(norm, MAX_AUTHORS_NOTE_CHARS + 1) > MAX_AUTHORS_NOTE_CHARS) {
    fidelity.push(`author's note truncated to ${MAX_AUTHORS_NOTE_CHARS.toLocaleString()} characters`);
    return sliceUnicodeScalarPrefix(norm, MAX_AUTHORS_NOTE_CHARS);
  }
  return norm;
}

function parseLegacyStory(storyRaw: unknown, title: string): GenericImport {
  if (!isRecord(storyRaw) || !Array.isArray(storyRaw.fragments)) {
    throw new ServiceError(400, "No importable prose found");
  }
  if (storyRaw.fragments.length > MAX_NOVELAI_RECORDS) {
    throw new ServiceError(
      400,
      `Story has more than ${MAX_NOVELAI_RECORDS} fragments — too large to import`
    );
  }

  let sourceChars = 0;
  const fragments: string[] = [];
  for (const fragment of storyRaw.fragments) {
    if (!isRecord(fragment) || typeof fragment.data !== "string") {
      throw new ServiceError(400, "Corrupt fragment in legacy story");
    }
    if (hasUnpairedSurrogate(fragment.data)) {
      throw new ServiceError(400, "Prose contains invalid Unicode");
    }
    sourceChars += fragment.data.length;
    if (sourceChars > MAX_TOTAL_CHARS) throw importTextTooLarge();
    fragments.push(fragment.data);
  }

  const prose = splitLegacyStoryLines(fragments.join(""));
  if (prose.normalizedLength > MAX_TOTAL_CHARS) throw importTextTooLarge();

  const parts: ImportedPart[] = [];
  const createdAt = new Date().toISOString();
  let partChars = 0;
  for (const line of prose.lines) {
    if (parts.length === MAX_PARTS) {
      throw new ServiceError(
        400,
        `Story has more than ${MAX_PARTS} lines — too large to import`
      );
    }
    partChars += line.length;
    if (partChars > MAX_TOTAL_CHARS) throw importTextTooLarge();
    parts.push({ instruction: "", text: line, createdAt });
  }
  if (parts.length === 0) {
    throw new ServiceError(400, "No importable prose found");
  }
  return { title, parts };
}

function importTextTooLarge(): ServiceError {
  return new ServiceError(400, "Story expands to more text than can be imported");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
