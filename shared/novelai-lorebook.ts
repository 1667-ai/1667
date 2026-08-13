import { countNoun } from "./fidelity.js";
import { hasPngSignature, readPngTextChunk } from "./png-text-chunk.js";
import { parseJsonRejectingDuplicateKeys } from "./strict-json.js";
import { isRecord } from "./types.js";
import {
  importEntries,
  type LorebookEntry,
  type LorebookImport,
  type LorebookRead
} from "./lorebook-entry.js";

/** NovelAI versions whose serialized entry shape is known to this importer.
 *
 * Versions 1, 3, and 4 use the same core `entries[]` fields as v6. Keep the
 * set explicit: accepting a future version would invent a compatibility
 * promise without evidence from a real export.
 */
export const SUPPORTED_LOREBOOK_VERSIONS = [1, 3, 4, 6] as const;
/** The current version written by the NovelAI exporter. */
export const SUPPORTED_LOREBOOK_VERSION = 6;
export const MAX_LOREBOOK_JSON_BYTES = 1_000_000;
/** The value budget every NovelAI import path shares. */
export const MAX_LOREBOOK_JSON_VALUES = 500_000;

export function isSupportedNovelAiLorebookVersion(
  value: unknown
): value is (typeof SUPPORTED_LOREBOOK_VERSIONS)[number] {
  return typeof value === "number"
    && SUPPORTED_LOREBOOK_VERSIONS.some((version) => version === value);
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

/** Read a NovelAI Lorebook: the `lorebookVersion` check and the
 * category→displayName resolution, turned into the canonical entry shape the
 * one Entry Mapping reads. */
export function entriesFromNovelAiLorebook(value: unknown): LorebookRead {
  if (!isRecord(value)) {
    throw new Error("Lorebook JSON must be an object.");
  }
  if (!isSupportedNovelAiLorebookVersion(value.lorebookVersion)) {
    throw new Error(
      `unsupported lorebookVersion ${value.lorebookVersion ?? "missing"}`
        + " · expected a NovelAI lorebook or a SillyTavern World Info file"
    );
  }

  const categoryMap = new Map<string, string>();
  if (Array.isArray(value.categories)) {
    for (const cat of value.categories) {
      if (isRecord(cat) && typeof cat.name === "string" && cat.name.trim().length > 0) {
        // Keep the name as written. The mapping trims once and counts it, so a
        // category tag and a display-name tag report the same way.
        if (typeof cat.id === "string" && cat.id.length > 0) {
          categoryMap.set(cat.id, cat.name);
        }
        categoryMap.set(cat.name.trim(), cat.name);
      }
    }
  }

  const rawEntries = Array.isArray(value.entries) ? value.entries : [];
  const entries: LorebookEntry[] = [];
  let unreadable = 0;
  for (const item of rawEntries) {
    // An item that is not a record cannot be read at all. Counting it keeps the
    // headline honest: an entry that vanishes without a reason is the one thing
    // the report exists to prevent.
    if (!isRecord(item)) {
      unreadable += 1;
      continue;
    }

    let displayName = "";
    if (typeof item.displayName === "string" && item.displayName.trim().length > 0) {
      displayName = item.displayName;
    } else if (typeof item.category === "string" && categoryMap.has(item.category)) {
      displayName = categoryMap.get(item.category)!;
    }

    entries.push({
      text: typeof item.text === "string" ? item.text : "",
      displayName,
      keys: Array.isArray(item.keys) ? item.keys : [],
      forceActivation: item.forceActivation === true,
      enabled: item.enabled !== false
    });
  }
  return {
    entries,
    sourceCount: rawEntries.length,
    fidelity: unreadable === 0
      ? []
      : [`${unreadable} ${countNoun(unreadable, "entry", "entries")} could not be read`]
  };
}

/** Turn a parsed Lorebook into Facts, bounded by the room the story has left.
 *
 * A thin wrapper over `entriesFromNovelAiLorebook` and `importEntries`, kept
 * for the callers that hand this a raw NovelAI Lorebook value directly. */
export function factsFromLorebook(
  value: unknown,
  room: number,
  bodyBudget?: number
): LorebookImport {
  return importEntries(entriesFromNovelAiLorebook(value), room, bodyBudget);
}
