import { countNoun, lossLines, type LossPhrases } from "./fidelity.js";
import type { LorebookEntry } from "./lorebook-entry.js";
import { readLeadingDecorators } from "./entry-decorators.js";
import { expandCharacterCardMacros } from "./character-card.js";
import { splitRegexKey } from "./fact-keys.js";
import { isRecord } from "./types.js";

/** A `character_book` can hold far more entries than a story has room for. The
 * Entry Mapping bounds the Facts; this bounds the reading that gets there. */
const MAX_CHARACTER_BOOK_ENTRIES = 10_000;

export interface CharacterBookEntries {
  /** The canonical entry shape, so one Entry Mapping serves every reader. */
  readonly entries: readonly LorebookEntry[];
  readonly fidelity: readonly string[];
  /** Entries the book held, including any this reader could not read. The
   * headline counts what the card held, not what survived the reader. */
  readonly sourceCount: number;
}

type CharacterBookLoss =
  | "unreadable"
  | "positioned"
  | "role"
  | "timed"
  | "caseSensitive"
  | "keyed"
  | "scanned"
  | "marked"
  | "decorated"
  | "refused";

const CHARACTER_BOOK_LOSS_PHRASES: LossPhrases<CharacterBookLoss> = {
  unreadable: (count) => `${count} ${countNoun(count, "entry", "entries")} could not be read`,
  positioned: (count) =>
    `${count} ${countNoun(count, "entry", "entries")} lost a position; a fact lands where 1667 puts facts`,
  role: (count) =>
    `${count} ${countNoun(count, "entry", "entries")}`
      + " lost a prompt role; a fact speaks as the system",
  timed: (count) =>
    `${count} ${countNoun(count, "entry", "entries")} lost a timed effect; a fact is judged on every request`,
  caseSensitive: (count) =>
    `${count} ${countNoun(count, "entry", "entries")} lost case-sensitive matching; a fact key ignores letter case`,
  keyed: (count) =>
    `${count} ${countNoun(count, "entry", "entries")} lost added or excluded decorator keys`,
  scanned: (count) =>
    `${count} ${countNoun(count, "entry", "entries")} lost a per-entry search range; the fact uses the book scan depth or the default`,
  marked: (count) =>
    `${count} ${countNoun(count, "entry", "entries")} marked as a greeting or an icon; each imports as an ordinary fact`,
  decorated: (count) => `${count} V3 ${countNoun(count, "decorator")} read and removed from the fact text`,
  refused: (count) => `${count} ${countNoun(count, "entry", "entries")} skipped for @@dont_activate`
};

/** `@@depth` and `@@role` are named individually; these four are the V3
 * spec's activation-timing family — they gate an entry by message count or
 * repeat match, which a Fact has no memory for and is judged on every
 * request. Anything else read from a decorator line falls to the generic
 * `decorated` reason, so an unrecognized one is still named. */
const TIMING_DECORATORS: ReadonlySet<string> = new Set([
  "@@activate_only_after",
  "@@activate_only_every",
  "@@keep_activate_after_match",
  "@@dont_activate_after_match"
]);

/** `@@additional_keys` and `@@exclude_keys` change which words activate the
 * entry; `@@scan_depth` changes how far back the search looks. Each is an
 * activation mechanism, so each gets its own reason rather than the generic
 * one — a writer whose fact fires on the wrong words learns why. */
const KEY_DECORATORS: ReadonlySet<string> = new Set(["@@additional_keys", "@@exclude_keys"]);

/** These mark the entry as something other than lore. 1667 has no greeting or
 * icon, so the entry still imports as an ordinary Fact and the report says the
 * card meant it as something else. */
const MARKER_DECORATORS: ReadonlySet<string> = new Set(["@@is_greeting", "@@is_user_icon"]);

/**
 * Turn a Character Card `character_book` into the Lorebook entry shape the
 * Entry Mapping already reads.
 *
 * A `character_book` entry can carry secondary keys, AND selection, and
 * regex keys. 1667 keeps those retrieval settings. It reports unsupported
 * position, timing, role, and case-sensitive settings.
 *
 * V3 decorators are honoured the same way SillyTavern World Info honours
 * them: `@@activate` and `@@dont_activate` decide whether the entry arrives
 * at all, so the same suppressed entry behaves the same way whether it
 * arrives as a World Info export or inside the V3 card it was written in.
 *
 * `macroName` is the same substitution identity the card's core sections
 * resolve `{{char}}` to — the V3 nickname when the card gives one, the name
 * otherwise (`characterCardMacroName` in `character-card.js`) — so a
 * `character_book` entry agrees with the rest of the same card instead of
 * reaching the Entry Mapping with the braces intact.
 */
export function entriesFromCharacterBook(value: unknown, macroName: string): CharacterBookEntries {
  const source = isRecord(value) && Array.isArray(value.entries) ? value.entries : [];
  if (source.length > MAX_CHARACTER_BOOK_ENTRIES) {
    throw new Error(
      `character_book has more than ${MAX_CHARACTER_BOOK_ENTRIES.toLocaleString("en-US")} entries.`
    );
  }

  const entries: LorebookEntry[] = [];
  const losses: CharacterBookLoss[] = [];
  const defaults = isRecord(value) ? bookActivationDefaults(value) : {};

  for (const item of source) {
    // An item that is not a record cannot be read at all. An entry that
    // vanishes without a reason is the one thing the report exists to prevent.
    if (!isRecord(item)) {
      losses.push("unreadable");
      continue;
    }
    const converted = convertCharacterBookEntry(item, macroName);
    losses.push(...converted.losses);
    if (converted.entry !== null) entries.push({ ...converted.entry, ...defaults });
  }

  const fidelity = lossLines(losses, CHARACTER_BOOK_LOSS_PHRASES);
  if (isRecord(value)) fidelity.push(...bookLevelFidelity(value));

  return { entries, sourceCount: source.length, fidelity };
}

/** `scan_depth`, `token_budget`, and `recursive_scanning` are book-level, not
 * per-entry, so they do not fit the counted `CharacterBookLoss` table above —
 * each is present at most once. Each gets its own reason, named only when the
 * book actually carries the field, rather than one vague catch-all covering
 * all three regardless of what the book set. */
function bookLevelFidelity(book: Record<string, unknown>): string[] {
  const lines: string[] = [];
  if (book.scan_depth !== undefined && book.scan_depth !== null && bookScanDepth(book.scan_depth) === undefined) {
    lines.push("the book's scan depth omitted because it is outside the Fact scan-depth range");
  }
  if (book.token_budget !== undefined && book.token_budget !== null) {
    lines.push("the book's token budget omitted; an activated fact is included in full");
  }
  return lines;
}

function bookActivationDefaults(book: Record<string, unknown>): Pick<LorebookEntry, "scanDepth" | "recursion"> {
  return {
    ...(bookScanDepth(book.scan_depth) === undefined ? {} : { scanDepth: bookScanDepth(book.scan_depth) }),
    ...(book.recursive_scanning === false ? { recursion: "off" as const } : {})
  };
}

function bookScanDepth(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 20
    ? value
    : undefined;
}

interface ConvertedEntry {
  readonly entry: LorebookEntry | null; // null when @@dont_activate refused it
  readonly losses: readonly CharacterBookLoss[]; // repeats allowed, one per occurrence
}

function convertCharacterBookEntry(item: Record<string, unknown>, macroName: string): ConvertedEntry {
  const decorated = readLeadingDecorators(typeof item.content === "string" ? item.content : "");
  const text = expandCharacterCardMacros(decorated.content, macroName);
  let depthDecorator = false;
  let roleDecorator = false;
  let timingDecorator = false;
  let keyDecorator = false;
  let scanDecorator = false;
  let markerDecorator = false;
  let otherDecorator = false;
  for (const line of decorated.decorators) {
    const name = decoratorName(line);
    if (name === "@@depth") depthDecorator = true;
    else if (name === "@@role") roleDecorator = true;
    else if (TIMING_DECORATORS.has(name)) timingDecorator = true;
    else if (KEY_DECORATORS.has(name)) keyDecorator = true;
    else if (name === "@@scan_depth") scanDecorator = true;
    else if (MARKER_DECORATORS.has(name)) markerDecorator = true;
    else otherDecorator = true;
  }

  // Decide whether the entry arrives at all before naming what a decorator or
  // a field would have lost, the same order World Info reads in: a mechanism
  // an entry never got to use is not a loss, and reporting one for an entry
  // that produced no Fact makes every count untrustworthy. Only the two exact
  // control lines are acted on; `@@activate` wins when both appear, and
  // anything else — including a malformed one, like `@@activate note` — is
  // still a control line and still leaves the prose, but does not get to
  // decide activation on a guess.
  const forced = decorated.decorators.includes("@@activate");
  if (!forced && decorated.decorators.includes("@@dont_activate")) {
    return { entry: null, losses: ["refused"] };
  }

  const displayName = displayNameOf(item);

  // A disabled entry never reaches the Entry Mapping as an active Fact — the
  // mapper reports the skip on its own, the same as a disabled World Info
  // entry — so it produced no Fact and needs no mechanism losses named here.
  if (item.enabled === false) {
    return {
      entry: {
        text,
        displayName,
        keys: [],
        forceActivation: false,
        enabled: false
      },
      losses: []
    };
  }

  const losses: CharacterBookLoss[] = [];
  if (depthDecorator) losses.push("positioned");
  if (roleDecorator) losses.push("role");
  if (timingDecorator) losses.push("timed");
  if (keyDecorator) losses.push("keyed");
  if (scanDecorator) losses.push("scanned");
  if (markerDecorator) losses.push("marked");
  if (otherDecorator) losses.push("decorated");

  // `insertion_order` is required by the spec, so this fires on nearly every
  // entry. That is honest: 1667 never keeps an entry's place in the prompt,
  // whichever of these three fields — or the `@@depth` decorator above —
  // asked for one.
  if (
    !depthDecorator
    && (
      (item.position !== undefined && item.position !== null)
      || (item.insertion_order !== undefined && item.insertion_order !== null)
      || (item.priority !== undefined && item.priority !== null)
    )
  ) {
    losses.push("positioned");
  }
  if (item.case_sensitive === true && item.use_regex !== true) losses.push("caseSensitive");

  const rawKeys = Array.isArray(item.keys) ? item.keys : [];
  const keys = item.use_regex === true ? regexMarkedKeys(rawKeys, item.case_sensitive !== true) : rawKeys;
  const rawSecondaryKeys = item.selective === true && Array.isArray(item.secondary_keys)
    ? item.secondary_keys
    : [];
  const secondaryKeys = item.use_regex === true
    ? regexMarkedKeys(rawSecondaryKeys, item.case_sensitive !== true)
    : rawSecondaryKeys;

  return {
    entry: {
      text,
      displayName,
      keys,
      ...(secondaryKeys.length === 0 ? {} : { secondaryKeys }),
      ...(item.selective === true ? { secondaryMode: "and" as const } : {}),
      forceActivation: item.constant === true || forced,
      enabled: true
    },
    losses
  };
}

/** A Character Card's `use_regex` marks bare key text as a regex source.
 * Keep already-marked keys unchanged so flags survive the import. */
function regexMarkedKeys(keys: readonly unknown[], insensitive: boolean): unknown[] {
  return keys.map((key) => {
    if (typeof key !== "string" || splitRegexKey(key) !== null) return key;
    return `/${escapeRegexDelimiter(key)}/${insensitive ? "i" : ""}`;
  });
}

function escapeRegexDelimiter(source: string): string {
  let escaped = "";
  let backslashes = 0;
  for (const character of source) {
    if (character === "/" && backslashes % 2 === 0) escaped += "\\";
    escaped += character;
    backslashes = character === "\\" ? backslashes + 1 : 0;
  }
  return escaped;
}

function displayNameOf(item: Record<string, unknown>): string {
  if (typeof item.name === "string" && item.name.trim().length > 0) return item.name;
  if (typeof item.comment === "string" && item.comment.trim().length > 0) return item.comment;
  return "";
}

/** The decorator's name, ignoring any `value` after it: `@@depth 0` and
 * `@@depth` are the same decorator with and without an argument. An
 * argument-less control like `@@activate` is matched by its exact full
 * line instead, so a malformed one like `@@activate note` does not count. */
function decoratorName(line: string): string {
  const match = /^@@[\w-]+/u.exec(line);
  return match === null ? line : match[0];
}
