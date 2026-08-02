import { countNoun, lossLines, type LossPhrases } from "./fidelity.js";
import type { LorebookEntry } from "./lorebook-entry.js";

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
  | "selective"
  | "caseSensitive"
  | "useRegex"
  | "decorated";

const CHARACTER_BOOK_LOSS_PHRASES: LossPhrases<CharacterBookLoss> = {
  unreadable: (count) => `${count} ${countNoun(count, "entry", "entries")} could not be read`,
  secondaryKeys: (count) =>
    `${count} ${countNoun(count, "entry", "entries")} lost secondary keys; a fact keys on one list`,
  positioned: (count) =>
    `${count} ${countNoun(count, "entry", "entries")} lost a position; a fact lands where 1667 puts facts`,
  selective: (count) =>
    `${count} ${countNoun(count, "entry", "entries")} lost selective matching; a fact has no AND/NOT logic`,
  caseSensitive: (count) =>
    `${count} ${countNoun(count, "entry", "entries")} lost case-sensitive matching; a fact key ignores letter case`,
  useRegex: (count) =>
    `${count} ${countNoun(count, "entry", "entries")} marked their keys as a regular expression; a fact key is literal`,
  decorated: (count) => `${count} V3 ${countNoun(count, "decorator")} read and removed from the fact text`
};

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
    entries.push(converted.entry);
  }

  return { entries, sourceCount: source.length, fidelity: lossLines(losses, CHARACTER_BOOK_LOSS_PHRASES) };
}

interface ConvertedEntry {
  readonly entry: LorebookEntry;
  readonly losses: readonly CharacterBookLoss[]; // repeats allowed, one per occurrence
}

function convertCharacterBookEntry(item: Record<string, unknown>): ConvertedEntry {
  const losses: CharacterBookLoss[] = [];

  if (Array.isArray(item.secondary_keys) && item.secondary_keys.length > 0) {
    losses.push("secondaryKeys");
  }
  // `insertion_order` is required by the spec, so this fires on nearly every
  // entry. That is honest: 1667 never keeps an entry's place in the prompt,
  // whichever of these three fields asked for one.
  if (
    (item.position !== undefined && item.position !== null)
    || (item.insertion_order !== undefined && item.insertion_order !== null)
    || (item.priority !== undefined && item.priority !== null)
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

  const decorated = readLeadingDecorators(typeof item.content === "string" ? item.content : "");
  if (decorated.decorators.length > 0) losses.push("decorated");

  let displayName = "";
  if (typeof item.name === "string" && item.name.trim().length > 0) {
    displayName = item.name;
  } else if (typeof item.comment === "string" && item.comment.trim().length > 0) {
    displayName = item.comment;
  }

  return {
    entry: {
      text: decorated.content,
      displayName,
      keys,
      forceActivation: item.constant === true,
      enabled: item.enabled !== false
    },
    losses
  };
}

/** Strip leading `@@decorator value` lines from `content`, the way the spec's
 * Decorators section describes: a decorator is a line starting with `@@` that
 * ends at a newline, and the newline after the run of decorators is trimmed
 * too. This reads the lines only to remove them; it does not act on any
 * decorator's meaning, which 1667 has no mechanism for. */
function readLeadingDecorators(content: string): {
  readonly decorators: readonly string[];
  readonly content: string;
} {
  const lines = content.split("\n");
  const decorators: string[] = [];
  let index = 0;
  while (index < lines.length && lines[index]!.startsWith("@@")) {
    decorators.push(lines[index]!);
    index += 1;
  }
  return { decorators, content: lines.slice(index).join("\n") };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
