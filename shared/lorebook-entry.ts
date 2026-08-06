import {
  MAX_FACTS,
  factImportRequestBytes,
  type FactInput
} from "./types.js";
import {
  DEFAULT_FACT_SCAN_PARTS,
  MAX_FACT_KEYS,
  MAX_FACT_KEY_SCALARS,
  factMetadataOverrides
} from "./fact-metadata.js";
import { normalizeFactText } from "./fact-scan.js";
import {
  factTagWithinLimit,
  factTextWithinLimit,
  truncateFactTag,
  truncateFactText
} from "./fact-limits.js";
import { countNoun, lossLines, type LossPhrases } from "./fidelity.js";
import {
  hasUnpairedSurrogate,
  sliceUnicodeScalarPrefix,
  unicodeScalarLength
} from "./unicode.js";
import { assertFactKey, splitRegexKey } from "./fact-keys.js";
import type { FactRecursion, FactSecondaryMode } from "./types.js";

/** The canonical entry shape every archive reader converts into, so one Entry
 * Mapping below is the only place an entry becomes a Fact. */
export interface LorebookEntry {
  readonly text: string;
  readonly displayName: string;
  readonly keys: readonly unknown[];
  readonly forceActivation: boolean;
  readonly enabled: boolean;
  readonly secondaryKeys?: readonly unknown[];
  readonly secondaryMode?: FactSecondaryMode;
  readonly scanDepth?: number;
  readonly recursion?: FactRecursion;
}

export interface LorebookImport {
  readonly facts: readonly FactInput[];
  readonly fidelity: readonly string[];
}

/** What every archive reader hands the Entry Mapping: the canonical entries,
 * plus the reader's own Fidelity Report lines and the count it read them
 * against. One shape for World Info, NovelAI, and the character_book
 * readers, so a fourth reader has one interface to implement rather than a
 * fourth copy of it. */
export interface LorebookRead {
  readonly entries: readonly LorebookEntry[];
  readonly fidelity: readonly string[];
  /** Entries the file held, including any the reader could not read. */
  readonly sourceCount: number;
}

type EntryLoss =
  | "disabled"
  | "textTruncated"
  | "textEmpty"
  | "textInvalid"
  | "textRelined"
  | "textTrimmed"
  | "tagCut"
  | "tagDropped"
  | "tagTrimmed"
  | "keysTruncated"
  | "keysTrimmed"
  | "keysDropped"
  | "keyedNoKeys";

const ENTRY_LOSS_PHRASES: LossPhrases<EntryLoss> = {
  disabled: (count) => `${count} disabled ${countNoun(count, "entry", "entries")} skipped`,
  textTruncated: (count) => `${count} ${countNoun(count, "entry", "entries")} truncated to 4,000 characters`,
  textEmpty: (count) => `${count} empty ${countNoun(count, "entry", "entries")} dropped`,
  textInvalid: (count) => `${count} ${countNoun(count, "entry", "entries")} dropped for invalid Unicode`,
  textRelined: (count) => `${count} fact ${countNoun(count, "body", "bodies")} changed to line feeds`,
  textTrimmed: (count) => `${count} fact ${countNoun(count, "body", "bodies")} trimmed of surrounding whitespace`,
  tagCut: (count) => `${count} ${countNoun(count, "tag")} cut to 48 characters`,
  tagDropped: (count) => `${count} ${countNoun(count, "tag")} dropped for invalid Unicode`,
  tagTrimmed: (count) => `${count} ${countNoun(count, "tag")} trimmed of surrounding whitespace`,
  keysTruncated: (count) => `${count} ${countNoun(count, "key")} cut to 64 characters`,
  keysTrimmed: (count) => `${count} ${countNoun(count, "key")} trimmed of surrounding whitespace`,
  keysDropped: (count) => `${count} ${countNoun(count, "key")} dropped`,
  keyedNoKeys: (count) =>
    `${count} keyed ${countNoun(count, "entry has no keys and will not activate", "entries have no keys and will not activate")}`
};

/** Turn Lorebook entries into Facts, bounded by the room the story has left.
 *
 * `bodyBudget` is the size of the request the caller will send. Only the
 * `import-lorebook` command sends one; a container import builds the story in
 * process, so it passes nothing and keeps every Fact that fits the ceiling. */
export function factsFromEntries(
  entries: readonly LorebookEntry[],
  room: number,
  bodyBudget?: number,
  sourceCount?: number
): LorebookImport {
  // A reader may refuse an entry before it reaches here. The headline counts
  // what the file held, or it would say "0 entries read" beside a reason for
  // skipping one of them.
  const entriesRead = sourceCount ?? entries.length;
  const losses: EntryLoss[] = [];
  const facts: FactInput[] = [];

  for (const item of entries) {
    if (!item.enabled) {
      losses.push("disabled");
      continue;
    }

    // One malformed entry must not cost the writer the whole lorebook, so a
    // bad entry is dropped and counted, like every other per-entry problem.
    const rawText = item.text;
    if (hasUnpairedSurrogate(rawText)) {
      losses.push("textInvalid");
      continue;
    }

    // 1667 stores Fact text exactly, and the prompt tells the model so. The
    // trim is right for a foreign archive, but it is a change either way, so
    // the report names it rather than letting it happen quietly.
    if (rawText.trim() !== rawText) losses.push("textTrimmed");
    const trimmedText = rawText.trim();
    const normalizedText = trimmedText.replace(/\r\n|\r|\u2028|\u2029/g, "\n");
    // A Fact can hold CRLF, CR, or a Unicode separator exactly, so folding them
    // to LF is a change to the writer's text and not only a parsing detail.
    if (normalizedText !== trimmedText) losses.push("textRelined");
    if (normalizedText.length === 0) {
      losses.push("textEmpty");
      continue;
    }

    let text = normalizedText;
    if (!factTextWithinLimit(text)) {
      text = truncateFactText(text);
      losses.push("textTruncated");
    }

    // The source picked its display name already; here it is only trimmed,
    // validated, and counted, whichever field supplied it.
    let rawTag: string | null = null;
    if (item.displayName.trim().length > 0) {
      rawTag = item.displayName.trim();
      if (rawTag !== item.displayName) losses.push("tagTrimmed");
    }

    let tag: string | null = rawTag;
    if (tag !== null) {
      // A tag is decoration on top of the entry. Losing it must not lose the
      // entry, so an unusable tag becomes no tag.
      if (hasUnpairedSurrogate(tag)) {
        tag = null;
        losses.push("tagDropped");
      } else if (!factTagWithinLimit(tag)) {
        tag = truncateFactTag(tag);
        losses.push("tagCut");
      }
    }

    const keys = normalizeImportedKeys(item.keys, losses);

    const activation = item.forceActivation ? "always" : "keyed";
    if (activation === "keyed" && keys.length === 0) {
      losses.push("keyedNoKeys");
    }

    const secondaryKeys = normalizeImportedKeys(item.secondaryKeys ?? [], losses);
    facts.push({
      tag,
      text,
      activation,
      keys,
      ...factMetadataOverrides({
        secondaryKeys,
        secondaryMode: item.secondaryMode ?? "and",
        scanDepth: item.scanDepth ?? DEFAULT_FACT_SCAN_PARTS,
        recursion: item.recursion ?? "on",
        priority: "normal"
      })
    });
  }

  let limitExceededCount = 0;
  const roomCap = Math.max(0, Math.min(room, MAX_FACTS));
  if (facts.length > roomCap) {
    limitExceededCount += facts.length - roomCap;
    facts.length = roomCap;
  }

  // The request body can bite before the Fact ceiling does, because the body is
  // counted in UTF-8 bytes while the text cap counts Unicode scalars. Drop
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
    `${facts.length} ${countNoun(facts.length, "fact")} imported`,
    ...lossLines(losses, ENTRY_LOSS_PHRASES)
  ];

  if (limitExceededCount > 0) {
    fidelity.push(`${limitExceededCount} ${countNoun(limitExceededCount, "entry", "entries")} did not fit the 128-fact limit`);
  }
  if (bodyDroppedCount > 0) {
    fidelity.push(
      `${bodyDroppedCount} ${countNoun(bodyDroppedCount, "fact")} dropped to fit the 1 MB request limit`
    );
  }
  fidelity.push("unsupported search ranges, bias groups, and advanced conditions omitted");

  return { facts, fidelity };
}

/** Normalize one imported key list before it reaches a FactInput.
 *
 * Primary and secondary keys use exactly the same storage and activation
 * grammar. Keeping this path shared prevents a secondary key from surviving
 * import but failing the server's Fact validation later. */
function normalizeImportedKeys(source: readonly unknown[], losses: EntryLoss[]): string[] {
  const keys: string[] = [];
  const seenKeys = new Set<string>();
  for (const value of source) {
    if (keys.length === MAX_FACT_KEYS || typeof value !== "string") {
      losses.push("keysDropped");
      continue;
    }

    const trimmedKey = value.trim();
    if (trimmedKey.length === 0) {
      losses.push("keysDropped");
      continue;
    }
    if (
      (trimmedKey.includes(",") && splitRegexKey(trimmedKey) === null)
      || /[\r\n\u2028\u2029]/u.test(trimmedKey)
      || hasUnpairedSurrogate(trimmedKey)
    ) {
      losses.push("keysDropped");
      continue;
    }

    const isRegex = splitRegexKey(trimmedKey) !== null;
    let key = trimmedKey;
    if (unicodeScalarLength(key, MAX_FACT_KEY_SCALARS + 1) > MAX_FACT_KEY_SCALARS) {
      if (isRegex) {
        losses.push("keysDropped");
        continue;
      }
      key = sliceUnicodeScalarPrefix(key, MAX_FACT_KEY_SCALARS);
      losses.push("keysTruncated");
    }

    // Case folding can grow a literal key. Validate the folded identity before
    // it can make the full Fact key list invalid.
    const identity = splitRegexKey(key) === null ? normalizeFactText(key) : key;
    if (unicodeScalarLength(identity, MAX_FACT_KEY_SCALARS + 1) > MAX_FACT_KEY_SCALARS) {
      losses.push("keysDropped");
      continue;
    }
    if (seenKeys.has(identity)) {
      losses.push("keysDropped");
      continue;
    }

    // This also compiles marked regex keys, without rechecking prior keys.
    try {
      assertFactKey(key, "import key");
    } catch {
      losses.push("keysDropped");
      continue;
    }

    if (trimmedKey !== value) losses.push("keysTrimmed");
    seenKeys.add(identity);
    keys.push(key);
  }
  return keys;
}

/** Turn one archive reader's result into Facts: the fidelity ordering rule
 * every reader shares, in one place. Mapping lines come first, because they
 * describe what happened to the entries the reader produced; the reader's
 * own lines follow, describing what never became an entry at all. */
export function importEntries(
  read: LorebookRead,
  room: number,
  bodyBudget?: number
): LorebookImport {
  const imported = factsFromEntries(read.entries, room, bodyBudget, read.sourceCount);
  return {
    facts: imported.facts,
    fidelity: [...imported.fidelity, ...read.fidelity]
  };
}

/** How many leading Facts fit `budget` once serialized as the request body.
 *
 * `JSON.stringify({facts})` is the envelope plus each Fact and one separator
 * between neighbours, so measuring each Fact once is enough. */
export function factsWithinBodyBudget(facts: readonly FactInput[], budget: number): number {
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
