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
import { countNoun, lossLines, type LossPhrases } from "./fidelity.js";
import {
  alignUtf16Boundary,
  hasUnpairedSurrogate,
  sliceUnicodeScalarPrefix,
  unicodeScalarLength
} from "./unicode.js";
import { factImportRequestBytes } from "./character-card.js";

/** The canonical entry shape every archive reader converts into, so one Entry
 * Mapping below is the only place an entry becomes a Fact. */
export interface LorebookEntry {
  readonly text: string;
  readonly displayName: string;
  readonly keys: readonly unknown[];
  readonly forceActivation: boolean;
  readonly enabled: boolean;
}

export interface LorebookImport {
  readonly facts: readonly FactInput[];
  readonly fidelity: readonly string[];
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
  bodyBudget?: number
): LorebookImport {
  const entriesRead = entries.length;
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
    if (text.length > MAX_FACT_TEXT_CHARS) {
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
      } else if (unicodeScalarLength(tag, MAX_FACT_TAG_CHARS + 1) > MAX_FACT_TAG_CHARS) {
        tag = sliceUnicodeScalarPrefix(tag, MAX_FACT_TAG_CHARS);
        losses.push("tagCut");
      }
    }

    const keys: string[] = [];
    const seenKeys = new Set<string>();

    // `parseFactKeys` throws on a comma, a line break, a duplicate, or a key
    // past the ceiling, so every one of those is settled here. A dropped key
    // costs the entry an activation trigger, so the report names the count.
    for (const keyCandidate of item.keys) {
      if (keys.length === MAX_FACT_KEYS) {
        losses.push("keysDropped");
        continue;
      }
      if (typeof keyCandidate !== "string") {
        losses.push("keysDropped");
        continue;
      }
      const trimmedKey = keyCandidate.trim();
      if (trimmedKey.length === 0) {
        losses.push("keysDropped");
        continue;
      }
      if (
        trimmedKey.includes(",")
        || /[\r\n\u2028\u2029]/u.test(trimmedKey)
        || hasUnpairedSurrogate(trimmedKey)
      ) {
        losses.push("keysDropped");
        continue;
      }

      let key = trimmedKey;
      if (unicodeScalarLength(key, MAX_FACT_KEY_SCALARS + 1) > MAX_FACT_KEY_SCALARS) {
        key = sliceUnicodeScalarPrefix(key, MAX_FACT_KEY_SCALARS);
        losses.push("keysTruncated");
      }

      // `parseFactKeys` measures the key again after case folding, and folding
      // can grow it: 33 dotted capital I fold to 66 scalars. A key that passes
      // here and fails there would abort the whole import, so it goes now.
      const normalizedKey = normalizeFactText(key);
      if (unicodeScalarLength(normalizedKey, MAX_FACT_KEY_SCALARS + 1) > MAX_FACT_KEY_SCALARS) {
        losses.push("keysDropped");
        continue;
      }
      if (seenKeys.has(normalizedKey)) {
        losses.push("keysDropped");
        continue;
      }
      seenKeys.add(normalizedKey);

      // A key is matched literally inside the scanned text, and the match
      // normalizes case but not spacing. So " storm " and "storm" activate at
      // different moments, and trimming one into the other is a real change.
      if (trimmedKey !== keyCandidate) losses.push("keysTrimmed");
      keys.push(key);
    }

    const activation = item.forceActivation ? "always" : "keyed";
    if (activation === "keyed" && keys.length === 0) {
      losses.push("keyedNoKeys");
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
  fidelity.push("search range, bias groups, and advanced conditions omitted");

  return { facts, fidelity };
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
