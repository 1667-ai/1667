import { ServiceError } from "./errors.js";
import {
  MAX_PARTS,
  MAX_TOTAL_CHARS,
  type GenericImport,
  type ImportedPart
} from "./import-st.js";
import {
  MAX_NOVELAI_RECORDS,
  partsFromNovelAiDocument
} from "./import-nai-document.js";
import { parseJsonRejectingDuplicateKeys } from "./strict-json.js";
import {
  MAX_IMPORT_BYTES,
  MAX_STORED_TITLE_CHARS
} from "../shared/types.js";
import {
  hasUnpairedSurrogate,
  sliceUnicodeScalarPrefix
} from "../shared/unicode.js";

export { MAX_IMPORT_BYTES, MAX_PARTS, MAX_TOTAL_CHARS };
export { MAX_NOVELAI_RECORDS as MAX_RECORDS };

const FALLBACK_TITLE = "Imported NovelAI story";

export function partsFromNovelAiStory(jsonText: string): GenericImport {
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
      "NovelAI story container"
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
  if (typeof document === "string" && document.length > 0) {
    return { title, parts: partsFromNovelAiDocument(document) };
  }
  if (document !== undefined && document !== "") {
    throw new ServiceError(400, "Malformed MessagePack document");
  }
  return parseLegacyStory(rawJson.content.story, title);
}

function importTitle(value: unknown): string {
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

  const prose = fragments.join("").normalize("NFC")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  if (prose.length > MAX_TOTAL_CHARS) throw importTextTooLarge();

  const parts: ImportedPart[] = [];
  const createdAt = new Date().toISOString();
  let partChars = 0;
  let start = 0;
  for (let index = 0; index <= prose.length; index += 1) {
    if (index < prose.length && prose[index] !== "\n") continue;
    const line = prose.slice(start, index);
    start = index + 1;
    if (line.trim().length === 0) continue;
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
