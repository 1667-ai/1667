import {
  MAX_FACTS,
  MAX_FACT_TAG_CHARS,
  MAX_FACT_TEXT_CHARS,
  type FactInput
} from "./types.js";
import {
  MAX_FACT_KEYS,
  MAX_FACT_KEY_SCALARS,
  normalizeFactText
} from "./fact-activation.js";
import { countNoun } from "./fidelity.js";
import {
  alignUtf16Boundary,
  hasUnpairedSurrogate,
  sliceUnicodeScalarPrefix,
  unicodeScalarLength
} from "./unicode.js";
import { factImportRequestBytes } from "./character-card.js";

import { hasPngSignature, readPngTextChunk } from "./png-text-chunk.js";
import { parseJsonRejectingDuplicateKeys } from "./strict-json.js";

export const SUPPORTED_LOREBOOK_VERSION = 6;
export const MAX_LOREBOOK_JSON_BYTES = 1_000_000;
/** The value budget every NovelAI import path shares. */
export const MAX_LOREBOOK_JSON_VALUES = 500_000;

export interface LorebookImport {
  readonly facts: readonly FactInput[];
  readonly fidelity: readonly string[];
}

/** Read a `.lorebook` file: JSON, or JSON inside a PNG text chunk. */
export function parseLorebookArchive(bytes: Uint8Array): unknown {
  if (bytes.byteLength === 0) {
    throw new Error("Lorebook file is empty.");
  }
  let jsonText: string;
  if (hasPngSignature(bytes)) {
    const chunk = readPngTextChunk(bytes, "naidata", "Lorebook");
    if (chunk === null) {
      throw new Error("no lorebook data in this PNG · export the lorebook again from NovelAI");
    }
    jsonText = chunk;
  } else {
    if (bytes.byteLength > MAX_LOREBOOK_JSON_BYTES) {
      throw new Error("Lorebook data exceeds the 1 MB limit.");
    }
    try {
      jsonText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("Lorebook data is not valid UTF-8.");
    }
  }

  // Every other NovelAI import path bounds its JSON and refuses a duplicate
  // key. A `.lorebook` is just as attacker-supplied, so it gets the same rule.
  let value: unknown;
  try {
    value = parseJsonRejectingDuplicateKeys(jsonText.replace(/^\uFEFF/, ""), {
      maxValues: MAX_LOREBOOK_JSON_VALUES
    });
  } catch {
    throw new Error("Lorebook data is not valid JSON.");
  }

  return value;
}

/** Turn a parsed Lorebook into Facts, bounded by the room the story has left.
 *
 * `bodyBudget` is the size of the request the caller will send. Only the
 * `import-lorebook` command sends one; a container import builds the story in
 * process, so it passes nothing and keeps every Fact that fits the ceiling. */
export function factsFromLorebook(
  value: unknown,
  room: number,
  bodyBudget?: number
): LorebookImport {
  if (!isRecord(value)) {
    throw new Error("Lorebook JSON must be an object.");
  }
  if (value.lorebookVersion !== SUPPORTED_LOREBOOK_VERSION) {
    throw new Error(
      `unsupported lorebookVersion ${value.lorebookVersion ?? "missing"} · export the lorebook again from NovelAI`
    );
  }

  const categoryMap = new Map<string, string>();
  if (Array.isArray(value.categories)) {
    for (const cat of value.categories) {
      if (isRecord(cat) && typeof cat.name === "string" && cat.name.trim().length > 0) {
        const name = cat.name.trim();
        if (typeof cat.id === "string" && cat.id.length > 0) {
          categoryMap.set(cat.id, name);
        }
        categoryMap.set(name, name);
      }
    }
  }

  const rawEntries = Array.isArray(value.entries) ? value.entries : [];
  const entriesRead = rawEntries.length;

  let disabledSkipped = 0;
  let textTruncatedCount = 0;
  let textEmptyCount = 0;
  let textInvalidCount = 0;
  let textTrimmedCount = 0;
  let tagCutCount = 0;
  let keyedNoKeysCount = 0;
  let keysDroppedCount = 0;
  let keysTrimmedCount = 0;

  const facts: FactInput[] = [];

  for (const item of rawEntries) {
    if (!isRecord(item)) continue;
    if (item.enabled === false) {
      disabledSkipped += 1;
      continue;
    }

    // One malformed entry must not cost the writer the whole lorebook, so a
    // bad entry is dropped and counted, like every other per-entry problem.
    const rawText = typeof item.text === "string" ? item.text : "";
    if (hasUnpairedSurrogate(rawText)) {
      textInvalidCount += 1;
      continue;
    }

    // 1667 stores Fact text exactly, and the prompt tells the model so. The
    // trim is right for a foreign archive, but it is a change either way, so
    // the report names it rather than letting it happen quietly.
    if (rawText.trim() !== rawText) textTrimmedCount += 1;
    const normalizedText = rawText.trim().replace(/\r\n|\r|\u2028|\u2029/g, "\n");
    if (normalizedText.length === 0) {
      textEmptyCount += 1;
      continue;
    }

    let text = normalizedText;
    if (text.length > MAX_FACT_TEXT_CHARS) {
      text = truncateFactText(text);
      textTruncatedCount += 1;
    }

    let rawTag: string | null = null;
    if (typeof item.displayName === "string" && item.displayName.trim().length > 0) {
      rawTag = item.displayName.trim();
    } else if (typeof item.category === "string" && categoryMap.has(item.category)) {
      rawTag = categoryMap.get(item.category)!;
    }

    let tag: string | null = rawTag;
    if (tag !== null) {
      // A tag is decoration on top of the entry. Losing it must not lose the
      // entry, so an unusable tag becomes no tag.
      if (hasUnpairedSurrogate(tag)) {
        tag = null;
      } else if (unicodeScalarLength(tag, MAX_FACT_TAG_CHARS + 1) > MAX_FACT_TAG_CHARS) {
        tag = sliceUnicodeScalarPrefix(tag, MAX_FACT_TAG_CHARS);
        tagCutCount += 1;
      }
    }

    const rawKeys = Array.isArray(item.keys) ? item.keys : [];
    const keys: string[] = [];
    const seenKeys = new Set<string>();

    // `parseFactKeys` throws on a comma, a line break, a duplicate, or a key
    // past the ceiling, so every one of those is settled here. A dropped key
    // costs the entry an activation trigger, so the report names the count.
    for (const keyCandidate of rawKeys) {
      if (keys.length === MAX_FACT_KEYS) {
        keysDroppedCount += 1;
        continue;
      }
      if (typeof keyCandidate !== "string") {
        keysDroppedCount += 1;
        continue;
      }
      const trimmedKey = keyCandidate.trim();
      if (trimmedKey.length === 0) {
        keysDroppedCount += 1;
        continue;
      }
      if (
        trimmedKey.includes(",")
        || /[\r\n\u2028\u2029]/u.test(trimmedKey)
        || hasUnpairedSurrogate(trimmedKey)
      ) {
        keysDroppedCount += 1;
        continue;
      }

      let key = trimmedKey;
      if (unicodeScalarLength(key, MAX_FACT_KEY_SCALARS + 1) > MAX_FACT_KEY_SCALARS) {
        key = sliceUnicodeScalarPrefix(key, MAX_FACT_KEY_SCALARS);
      }

      const normalizedKey = normalizeFactText(key);
      if (seenKeys.has(normalizedKey)) {
        keysDroppedCount += 1;
        continue;
      }
      seenKeys.add(normalizedKey);

      // A key is matched literally inside the scanned text, and the match
      // normalizes case but not spacing. So " storm " and "storm" activate at
      // different moments, and trimming one into the other is a real change.
      if (key !== keyCandidate) keysTrimmedCount += 1;
      keys.push(key);
    }

    const activation = item.forceActivation === true ? "always" : "keyed";
    if (activation === "keyed" && keys.length === 0) {
      keyedNoKeysCount += 1;
    }

    facts.push({
      tag,
      text,
      activation,
      keys
    });
  }

  let limitExceededCount = 0;
  const roomCap = Math.max(0, Math.min(room, MAX_FACTS));
  if (facts.length > roomCap) {
    limitExceededCount += facts.length - roomCap;
    facts.length = roomCap;
  }

  // The request body can bite before the Fact ceiling does, because the body is
  // counted in UTF-8 bytes while the text cap counts UTF-16 code units. Drop
  // from the end rather than refuse, because a writer cannot shorten a large
  // lorebook by hand. This is a different reason from the Fact ceiling, so it
  // gets its own count.
  //
  // A container import sends no request, so it passes no budget and keeps every
  // Fact. Applying a request limit there would lose Facts on a round trip that
  // never made a request.
  let bodyDroppedCount = 0;
  if (bodyBudget !== undefined && factImportRequestBytes(facts) > bodyBudget) {
    const kept = factsWithinBodyBudget(facts, bodyBudget);
    bodyDroppedCount = facts.length - kept;
    facts.length = kept;
  }

  const fidelity: string[] = [
    `${entriesRead} ${countNoun(entriesRead, "entry", "entries")} read`,
    `${facts.length} ${countNoun(facts.length, "fact")} imported`
  ];

  if (disabledSkipped > 0) {
    fidelity.push(`${disabledSkipped} disabled ${countNoun(disabledSkipped, "entry", "entries")} skipped`);
  }
  if (textTruncatedCount > 0) {
    fidelity.push(`${textTruncatedCount} ${countNoun(textTruncatedCount, "entry", "entries")} truncated to 4,000 characters`);
  }
  if (textEmptyCount > 0) {
    fidelity.push(`${textEmptyCount} empty ${countNoun(textEmptyCount, "entry", "entries")} dropped`);
  }
  if (textInvalidCount > 0) {
    fidelity.push(
      `${textInvalidCount} ${countNoun(textInvalidCount, "entry", "entries")} dropped for invalid Unicode`
    );
  }
  if (textTrimmedCount > 0) {
    fidelity.push(
      `${textTrimmedCount} fact ${countNoun(textTrimmedCount, "body", "bodies")} trimmed of surrounding whitespace`
    );
  }
  if (tagCutCount > 0) {
    fidelity.push(`${tagCutCount} ${countNoun(tagCutCount, "tag")} cut to 48 characters`);
  }
  if (keysTrimmedCount > 0) {
    fidelity.push(
      `${keysTrimmedCount} ${countNoun(keysTrimmedCount, "key")} trimmed of surrounding whitespace`
    );
  }
  if (keysDroppedCount > 0) {
    fidelity.push(`${keysDroppedCount} ${countNoun(keysDroppedCount, "key")} dropped`);
  }
  if (keyedNoKeysCount > 0) {
    fidelity.push(
      `${keyedNoKeysCount} keyed ${countNoun(keyedNoKeysCount, "entry has no keys and will not activate", "entries have no keys and will not activate")}`
    );
  }
  if (limitExceededCount > 0) {
    fidelity.push(`${limitExceededCount} ${countNoun(limitExceededCount, "entry", "entries")} did not fit the 128-fact limit`);
  }
  if (bodyDroppedCount > 0) {
    fidelity.push(
      `${bodyDroppedCount} ${countNoun(bodyDroppedCount, "fact")} dropped to fit the 1 MB request limit`
    );
  }
  fidelity.push("search range, bias groups, and advanced conditions omitted");

  return { facts, fidelity };
}

export /** How many leading Facts fit `budget` once serialized as the request body.
 *
 * `JSON.stringify({facts})` is the envelope plus each Fact and one separator
 * between neighbours, so measuring each Fact once is enough. */
function factsWithinBodyBudget(facts: readonly FactInput[], budget: number): number {
  const envelope = factImportRequestBytes([]);
  let total = envelope;
  for (let index = 0; index < facts.length; index += 1) {
    const size = factImportRequestBytes([facts[index]!]) - envelope
      + (index === 0 ? 0 : 1);
    if (total + size > budget) return index;
    total += size;
  }
  return facts.length;
}

export function truncateFactText(text: string): string {
  const max = MAX_FACT_TEXT_CHARS;
  const floor = Math.floor(max / 2);
  let cut = lastBoundary(text, "\n\n", floor, max);
  if (cut === -1) cut = lastBoundary(text, "\n", floor, max);
  if (cut === -1) {
    cut = max;
    for (let index = max - 1; index >= floor; index -= 1) {
      if (/\s/u.test(text[index]!)) {
        cut = index + 1;
        break;
      }
    }
  }
  return text.slice(0, alignUtf16Boundary(text, cut)).trimEnd();
}

function lastBoundary(text: string, boundary: string, start: number, end: number): number {
  for (let index = end - boundary.length; index >= start; index -= 1) {
    if (text.startsWith(boundary, index)) return index + boundary.length;
  }
  return -1;
}



function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
