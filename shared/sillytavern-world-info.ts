import { countNoun, lossLines, type LossPhrases } from "./fidelity.js";
import type { LorebookEntry, LorebookRead } from "./lorebook-entry.js";
import { readLeadingDecorators } from "./entry-decorators.js";
import { isRecord } from "./types.js";

/** A World Info file can hold far more entries than a story has room for. The
 * mapping bounds the Facts; this bounds the reading that gets there. */
const MAX_WORLD_INFO_ENTRIES = 10_000;

/** Places upstream can look for a key that a Fact does not read. */
const SCAN_SOURCE_FIELDS = [
  "matchPersonaDescription",
  "matchCharacterDescription",
  "matchCharacterPersonality",
  "matchCharacterDepthPrompt",
  "matchScenario",
  "matchCreatorNotes"
] as const;

type WorldInfoLoss =
  | "secondaryKey"
  | "positioned"
  | "chance"
  | "recursive"
  | "regexKey"
  | "timed"
  | "matchRule"
  | "grouped"
  | "decorated"
  | "refused"
  | "paddedPatternKey"
  | "scanSource"
  | "macro"
  | "vector"
  | "filtered"
  | "unreadable"
  | "role";

const WORLD_INFO_LOSS_PHRASES: LossPhrases<WorldInfoLoss> = {
  role: (count) =>
    `${count} ${countNoun(count, "entry", "entries")}`
      + " lost a prompt role; a fact speaks as the system",
  unreadable: (count) =>
    `${count} ${countNoun(count, "entry", "entries")} could not be read`,
  secondaryKey: (count) =>
    `${count} ${countNoun(count, "entry", "entries")} lost secondary keys; a fact keys on one list`,
  positioned: (count) => `${count} insertion ${countNoun(count, "position")} omitted`,
  chance: (count) =>
    `${count} ${countNoun(count, "entry", "entries")} will always fire; a fact has no probability`,
  recursive: (count) => `${count} recursion ${countNoun(count, "setting")} omitted`,
  regexKey: (count) =>
    `${count} regular expression ${countNoun(count, "key")} dropped; a fact key is literal`,
  timed: (count) =>
    `${count} ${countNoun(count, "entry", "entries")} lost a timed effect; a fact is judged on every request`,
  matchRule: (count) =>
    `${count} ${countNoun(count, "entry", "entries")} lost a matching rule; a fact key matches a whole key without case`,
  grouped: (count) =>
    `${count} grouped ${countNoun(count, "entry", "entries")} can now be active together; a group chose one`,
  decorated: (count) => `${count} activation ${countNoun(count, "decorator")} read and removed`,
  refused: (count) => `${count} ${countNoun(count, "entry", "entries")} skipped for @@dont_activate`,
  paddedPatternKey: (count) =>
    `${count} spaced ${countNoun(count, "key")} looks like a pattern and imports as literal text`,
  scanSource: (count) =>
    `${count} ${countNoun(count, "entry", "entries")} lost an extra scan source; a fact scans the story`,
  macro: (count) =>
    `${count} ${countNoun(count, "entry", "entries")} kept a {{macro}} unexpanded; a fact carries no character or chat`,
  vector: (count) =>
    `${count} vectorized ${countNoun(count, "entry", "entries")} lost retrieval by meaning; a fact is always on or keyed`,
  filtered: (count) =>
    `${count} ${countNoun(count, "entry", "entries")} lost a character or trigger filter and now applies everywhere`
};

/** True when the value is a SillyTavern World Info file rather than a NovelAI
 * Lorebook.
 *
 * The two are told apart by shape, not by file name: NovelAI numbers its format
 * and lists its entries, while World Info keys its entries by uid. */
export function isWorldInfo(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.lorebookVersion !== undefined) return false;
  return isRecord(value.entries);
}

interface ConvertedEntry {
  readonly entry: LorebookEntry | null; // null when @@dont_activate refused it
  readonly losses: readonly WorldInfoLoss[]; // repeats allowed, one per occurrence
}

/**
 * Turn a SillyTavern World Info file into the Lorebook entry shape the Entry
 * Mapping already reads.
 *
 * World Info carries retrieval machinery that 1667 has no place for: secondary
 * keys with their own AND and NOT logic, an insertion position and depth, a
 * firing probability, and recursion controls. A Fact is either always in
 * context or keyed on its own list, so those mechanisms are counted and named
 * rather than approximated into something that would fire at the wrong time.
 */
export function lorebookFromWorldInfo(value: unknown): LorebookRead {
  if (!isRecord(value) || !isRecord(value.entries)) {
    throw new Error("World Info must be an object with an entries object.");
  }

  const source = Object.values(value.entries);
  if (source.length > MAX_WORLD_INFO_ENTRIES) {
    throw new Error(
      `World Info has more than ${MAX_WORLD_INFO_ENTRIES.toLocaleString("en-US")} entries.`
    );
  }

  const entries: LorebookEntry[] = [];
  const losses: WorldInfoLoss[] = [];

  for (const item of source) {
    // An item that is not a record cannot be read at all. An entry that
    // vanishes without a reason is the one thing the report exists to prevent.
    if (!isRecord(item)) {
      losses.push("unreadable");
      continue;
    }
    const converted = convertWorldInfoEntry(item);
    losses.push(...converted.losses);
    if (converted.entry !== null) entries.push(converted.entry);
  }

  const fidelity = lossLines(losses, WORLD_INFO_LOSS_PHRASES);
  // True of every entry, whatever the file asked for, so it is stated once
  // rather than counted.
  fidelity.push("a fact key matches a whole key and ignores letter case");
  fidelity.push("scan depth, order, and other World Info settings omitted");

  return { entries, fidelity, sourceCount: source.length };
}

function convertWorldInfoEntry(item: Record<string, unknown>): ConvertedEntry {
  const losses: WorldInfoLoss[] = [];
  const rawContent = typeof item.content === "string" ? item.content : "";
  const decorated = readLeadingDecorators(rawContent);
  if (decorated.decorators.length > 0) losses.push("decorated");

  // Decide whether the entry arrives at all before naming what it would have
  // lost. A mechanism an entry never got to use is not a loss, and reporting
  // one for an entry that produced no Fact makes every count untrustworthy.
  const forced = decorated.decorators.includes("@@activate");
  if (!forced && decorated.decorators.includes("@@dont_activate")) {
    losses.push("refused");
    return { entry: null, losses };
  }
  if (item.disable === true) {
    // The mapper reports the skip, so this entry needs no reason of its own.
    return {
      entry: {
        text: decorated.content,
        displayName: typeof item.comment === "string" ? item.comment : "",
        keys: [],
        forceActivation: false,
        enabled: false
      },
      losses
    };
  }

  if (Array.isArray(item.keysecondary) && item.keysecondary.length > 0) {
    losses.push("secondaryKey");
  }
  // Position 4 is "at depth"; the rest name a place in the prompt that a Fact
  // does not choose. Either way the Fact lands where 1667 puts Facts.
  if (item.position !== undefined && item.position !== null) losses.push("positioned");
  // An at-depth entry can speak as the user or the assistant. A Fact always
  // enters as the system, which is a different authority, not a different place.
  if (item.role !== undefined && item.role !== null && item.role !== 0) {
    losses.push("role");
  }
  if (item.useProbability === true && typeof item.probability === "number"
    && item.probability < 100) {
    losses.push("chance");
  }
  // `delayUntilRecursion` holds an entry back from the first scan, and it is
  // a number as often as a boolean.
  // Current files write numeric 0 for "no delay", so only true or a positive
  // level counts. Otherwise an ordinary file reports a loss it never had.
  const delayed = isPositive(item.delayUntilRecursion);
  if (item.recursion === true || item.excludeRecursion === true
    || item.preventRecursion === true || delayed) {
    losses.push("recursive");
  }
  // sticky, cooldown, and delay hold an entry in or out of context for a
  // number of turns. A Fact is judged fresh on every request.
  if (isPositive(item.sticky) || isPositive(item.cooldown) || isPositive(item.delay)) {
    losses.push("timed");
  }
  // A Fact key matches case-insensitively on a whole key. An entry that asked
  // for something else will fire at different moments.
  if (item.caseSensitive === true || item.matchWholeWords === false) {
    losses.push("matchRule");
  }
  // These add places upstream looks for a key. A Fact scans the story
  // context, the instruction, and the selected text, and nothing else.
  if (SCAN_SOURCE_FIELDS.some((field) => item[field] === true)) losses.push("scanSource");
  // A vectorized entry is retrieved by meaning, not by a key, and usually
  // carries no keys at all. There is no such retrieval here.
  if (item.vectorized === true) losses.push("vector");
  // An entry can be limited to a character or to a kind of generation. A Fact
  // has no such condition, so an entry that was narrow becomes universal.
  if (isNonEmptyArray(item.triggers) || hasCharacterFilter(item.characterFilter)) {
    losses.push("filtered");
  }
  // Entries sharing a group are exclusive upstream: one of them is used.
  // Independent Facts have no such contest, so they can all be active.
  if (typeof item.group === "string" && item.group.trim().length > 0) losses.push("grouped");

  // SillyTavern reads a key written as /pattern/flags as a regular
  // expression. A Fact key is literal, so keeping one would leave a key that
  // fires only on the pattern's own text. Drop it and say so.
  const sourceKeys = Array.isArray(item.key) ? item.key : [];
  // SillyTavern expands {{macros}} against a character and a chat before the
  // text is used. A World Info file carries neither, so the braces stay as
  // the writer wrote them and a macro key cannot match.
  if (hasMacro(rawContent) || sourceKeys.some(hasMacro)) losses.push("macro");
  const literalKeys = sourceKeys.filter((key) => {
    if (typeof key !== "string") return true;
    // An exact pattern is a pattern. A padded one is ambiguous: it is
    // slash-delimited but not anchored, so upstream may read it either way.
    // Keep it, because a dropped key can cost an entry its only trigger, and
    // name it so the writer is not left with a key that quietly never fires.
    if (isRegexKey(key)) {
      losses.push("regexKey");
      return false;
    }
    if (key !== key.trim() && isRegexKey(key.trim())) losses.push("paddedPatternKey");
    return true;
  });

  return {
    entry: {
      text: decorated.content,
      displayName: typeof item.comment === "string" ? item.comment : "",
      keys: literalKeys,
      forceActivation: item.constant === true || forced,
      // World Info switches an entry off with `disable`; a Lorebook switches it
      // on with `enabled`. Read both so neither file loses the writer's choice.
      enabled: item.disable !== true
    },
    losses
  };
}

/** `/pattern/flags`, the form SillyTavern reads as a regular expression.
 *
 * A key is only a pattern when the pattern compiles. `/(/` looks like one and
 * is literal text upstream, so treating it as a pattern would delete a key that
 * works. When in doubt the key stays. */
function isRegexKey(key: string): boolean {
  const match = /^\/([\s\S]+)\/([a-z]*)$/u.exec(key);
  if (match === null) return false;
  const pattern = match[1]!;
  const flags = match[2]!;
  // A pattern ends at its first unescaped delimiter, so `/foo/bar/` is not one
  // pattern. Upstream reads it as literal text, and so does this.
  if (hasUnescapedSlash(pattern)) return false;
  // Only the flags SillyTavern accepts. A host that supports more, such as `d`,
  // must not make a literal key look like a pattern.
  if (!/^[gimsuy]*$/u.test(flags) || new Set(flags).size !== flags.length) return false;
  try {
    new RegExp(pattern, flags);
    return true;
  } catch {
    return false;
  }
}

function hasUnescapedSlash(pattern: string): boolean {
  for (let index = 0; index < pattern.length; index += 1) {
    if (pattern[index] === "\\") {
      index += 1;
      continue;
    }
    if (pattern[index] === "/") return true;
  }
  return false;
}

function isNonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function hasCharacterFilter(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return isNonEmptyArray(value.names) || isNonEmptyArray(value.tags);
}

function hasMacro(value: unknown): boolean {
  return typeof value === "string" && /\{\{[^}]+\}\}/u.test(value);
}

function isPositive(value: unknown): boolean {
  return typeof value === "number" ? value > 0 : value === true;
}
