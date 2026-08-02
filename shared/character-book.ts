import { countNoun, lossLines, type LossPhrases } from "./fidelity.js";
import type { LorebookEntry } from "./lorebook-entry.js";
import { readLeadingDecorators } from "./entry-decorators.js";
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
  | "secondaryKeys"
  | "positioned"
  | "role"
  | "timed"
  | "selective"
  | "caseSensitive"
  | "useRegex"
  | "decorated"
  | "refused";

const CHARACTER_BOOK_LOSS_PHRASES: LossPhrases<CharacterBookLoss> = {
  unreadable: (count) => `${count} ${countNoun(count, "entry", "entries")} could not be read`,
  secondaryKeys: (count) =>
    `${count} ${countNoun(count, "entry", "entries")} lost secondary keys; a fact keys on one list`,
  positioned: (count) =>
    `${count} ${countNoun(count, "entry", "entries")} lost a position; a fact lands where 1667 puts facts`,
  role: (count) =>
    `${count} ${countNoun(count, "entry", "entries")}`
      + " lost a prompt role; a fact speaks as the system",
  timed: (count) =>
    `${count} ${countNoun(count, "entry", "entries")} lost a timed effect; a fact is judged on every request`,
  selective: (count) =>
    `${count} ${countNoun(count, "entry", "entries")} lost selective matching; a fact has no AND/NOT logic`,
  caseSensitive: (count) =>
    `${count} ${countNoun(count, "entry", "entries")} lost case-sensitive matching; a fact key ignores letter case`,
  useRegex: (count) =>
    `${count} ${countNoun(count, "entry", "entries")} marked their keys as a regular expression; a fact key is literal`,
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

/**
 * Turn a Character Card `character_book` into the Lorebook entry shape the
 * Entry Mapping already reads.
 *
 * A `character_book` entry carries retrieval machinery 1667 has no place for:
 * secondary keys with selective AND/NOT logic, a position and priority, and
 * regular-expression keys. A Fact is either always in context or keyed on its
 * own literal list, so those mechanisms are counted and named rather than
 * approximated into something that would fire at the wrong time, or not at
 * all.
 *
 * V3 decorators are honoured the same way SillyTavern World Info honours
 * them: `@@activate` and `@@dont_activate` decide whether the entry arrives
 * at all, so the same suppressed entry behaves the same way whether it
 * arrives as a World Info export or inside the V3 card it was written in.
 */
export function entriesFromCharacterBook(value: unknown): CharacterBookEntries {
  const source = isRecord(value) && Array.isArray(value.entries) ? value.entries : [];
  if (source.length > MAX_CHARACTER_BOOK_ENTRIES) {
    throw new Error(
      `character_book has more than ${MAX_CHARACTER_BOOK_ENTRIES.toLocaleString("en-US")} entries.`
    );
  }

  const entries: LorebookEntry[] = [];
  const losses: CharacterBookLoss[] = [];

  for (const item of source) {
    // An item that is not a record cannot be read at all. An entry that
    // vanishes without a reason is the one thing the report exists to prevent.
    if (!isRecord(item)) {
      losses.push("unreadable");
      continue;
    }
    const converted = convertCharacterBookEntry(item);
    losses.push(...converted.losses);
    if (converted.entry !== null) entries.push(converted.entry);
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
  if (book.scan_depth !== undefined && book.scan_depth !== null) {
    lines.push("the book's scan depth omitted; a fact is judged on every request, not a limited recent window");
  }
  if (book.token_budget !== undefined && book.token_budget !== null) {
    lines.push("the book's token budget omitted; an activated fact is included in full");
  }
  if (book.recursive_scanning !== undefined && book.recursive_scanning !== null) {
    lines.push("the book's recursive scanning omitted; a fact never activates another fact by its own text");
  }
  return lines;
}

interface ConvertedEntry {
  readonly entry: LorebookEntry | null; // null when @@dont_activate refused it
  readonly losses: readonly CharacterBookLoss[]; // repeats allowed, one per occurrence
}

function convertCharacterBookEntry(item: Record<string, unknown>): ConvertedEntry {
  const decorated = readLeadingDecorators(typeof item.content === "string" ? item.content : "");
  let depthDecorator = false;
  let roleDecorator = false;
  let timingDecorator = false;
  let otherDecorator = false;
  for (const line of decorated.decorators) {
    const name = decoratorName(line);
    if (name === "@@depth") depthDecorator = true;
    else if (name === "@@role") roleDecorator = true;
    else if (TIMING_DECORATORS.has(name)) timingDecorator = true;
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
        text: decorated.content,
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
  if (otherDecorator) losses.push("decorated");

  if (Array.isArray(item.secondary_keys) && item.secondary_keys.length > 0) {
    losses.push("secondaryKeys");
  }
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
  if (item.selective === true) losses.push("selective");
  if (item.case_sensitive === true) losses.push("caseSensitive");

  // `use_regex` makes every key in the entry a pattern, not a literal string.
  // Keeping the pattern text as a literal Fact key would fire only on the
  // pattern's own text, which is worse than the entry having no keys at all.
  let keys: unknown[] = Array.isArray(item.keys) ? item.keys : [];
  if (item.use_regex === true && keys.length > 0) {
    losses.push("useRegex");
    keys = [];
  }

  return {
    entry: {
      text: decorated.content,
      displayName,
      keys,
      forceActivation: item.constant === true || forced,
      enabled: true
    },
    losses
  };
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

