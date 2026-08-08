import { Unpackr, addExtension } from "msgpackr/unpack";
import { ServiceError } from "./errors.js";
import {
  MAX_PARTS,
  MAX_TOTAL_CHARS,
  type ImportedPart
} from "./import-model.js";
import {
  type NovelAiSection,
  type SectionId,
  applyDirtySections,
  isPlainRecord,
  normalizeSectionText,
  readOrder,
  readSections
} from "./import-nai-sections.js";
import { alternatesFromNovelAiHistory } from "./import-nai-history.js";
import {
  assertBoundedNovelAiMessagePack,
  MAX_NOVELAI_RECORDS
} from "./import-nai-msgpack-preflight.js";

export { MAX_NOVELAI_RECORDS };

interface DecodedDocument {
  sections?: Map<unknown, unknown> | Record<string, unknown>;
  order?: unknown[];
  dirtySections?: Map<unknown, unknown> | Record<string, unknown>;
  history?: unknown;
}

// NovelAI's classes use msgpackr's structured extension form: a fixext marker
// followed by an ordinary encoded value. We only need the decoded data shape.
for (const type of [20, 30, 31, 40, 41, 42]) {
  addExtension({
    type,
    read(data: unknown) {
      return data;
    }
  });
}

const unpackr = new Unpackr({
  bundleStrings: true,
  moreTypes: true,
  structuredClone: false,
  mapsAsObjects: false
});

export interface NovelAiDocumentImport {
  readonly parts: readonly ImportedPart[];
  readonly fidelity: readonly string[];
}

export function partsFromNovelAiDocument(base64: string): NovelAiDocumentImport {
  const bytes = parseCanonicalBase64(base64);
  if (bytes.length < 3
    || bytes[0] !== 0xd4
    || bytes[1] !== 20
    || bytes[2] !== 0) {
    throw new ServiceError(400, "Malformed NovelAI Document envelope");
  }
  assertBoundedNovelAiMessagePack(bytes);

  let decoded: unknown;
  try {
    decoded = unpackr.unpack(bytes);
  } catch {
    throw new ServiceError(400, "Malformed MessagePack document");
  }
  if (!isPlainRecord(decoded) || !Array.isArray(decoded.order)) {
    throw new ServiceError(400, "Document missing sections or order");
  }

  const document = decoded as DecodedDocument;
  if (!(document.sections instanceof Map) && !isPlainRecord(document.sections)) {
    throw new ServiceError(400, "Malformed sections map");
  }
  const sections = readSections(document.sections);
  let order = readOrder(decoded.order, sections);
  if (sections.size !== order.length) {
    throw new ServiceError(400, "Document contains an unordered section");
  }
  if (document.dirtySections !== undefined
    && !(document.dirtySections instanceof Map)
    && !isPlainRecord(document.dirtySections)) {
    throw new ServiceError(400, "Malformed dirty sections map");
  }
  if (document.dirtySections !== undefined) {
    order = applyDirtySections(sections, order, document.dirtySections);
  }

  const { parts, sectionIndex } = importedParts(sections, order);
  const fidelity: string[] = [];
  const alternates = alternatesFromNovelAiHistory(document.history, {
    parts,
    sectionIndex,
    room: MAX_PARTS - parts.length,
    charsRoom: MAX_TOTAL_CHARS - totalChars(parts)
  });
  fidelity.push(...alternates.fidelity);

  return { parts: [...parts, ...alternates.parts], fidelity };
}

function totalChars(parts: readonly ImportedPart[]): number {
  let total = 0;
  for (const part of parts) total += part.text.length;
  return total;
}

function parseCanonicalBase64(value: string): Buffer {
  if (value.length === 0 || value.length % 4 !== 0) {
    throw new ServiceError(400, "Malformed base64 document");
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const dataLength = value.length - padding;
  for (let index = 0; index < dataLength; index += 1) {
    if (!isBase64Code(value.charCodeAt(index))) {
      throw new ServiceError(400, "Malformed base64 document");
    }
  }
  for (let index = dataLength; index < value.length; index += 1) {
    if (value[index] !== "=") {
      throw new ServiceError(400, "Malformed base64 document");
    }
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== value) {
    throw new ServiceError(400, "Malformed base64 document");
  }
  return bytes;
}

function isBase64Code(code: number): boolean {
  return (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122)
    || (code >= 48 && code <= 57)
    || code === 43
    || code === 47;
}

/** The active reading: every non-blank section, in order, plus a map back
 * from a section's ID to the part it became — the anchor a retry history
 * branch attaches an alternate to. */
function importedParts(
  sections: ReadonlyMap<SectionId, NovelAiSection>,
  order: readonly SectionId[]
): { parts: ImportedPart[]; sectionIndex: ReadonlyMap<SectionId, number> } {
  const parts: ImportedPart[] = [];
  const sectionIndex = new Map<SectionId, number>();
  const createdAt = new Date().toISOString();
  let totalTextChars = 0;
  for (const id of order) {
    const section = sections.get(id);
    if (section === undefined) {
      throw new ServiceError(400, "Document order contains an absent section");
    }
    if (section.type !== 1) continue;
    const text = normalizeSectionText(section.text);
    if (text.trim().length === 0) continue;
    if (parts.length === MAX_PARTS) {
      throw new ServiceError(
        400,
        `Story has more than ${MAX_PARTS} sections — too large to import`
      );
    }
    totalTextChars += text.length;
    if (totalTextChars > MAX_TOTAL_CHARS) throw importTextTooLarge();
    sectionIndex.set(id, parts.length);
    parts.push({ instruction: "", text, createdAt });
  }
  if (parts.length === 0) {
    throw new ServiceError(400, "No importable prose found");
  }
  return { parts, sectionIndex };
}

function importTextTooLarge(): ServiceError {
  return new ServiceError(400, "Story expands to more text than can be imported");
}
