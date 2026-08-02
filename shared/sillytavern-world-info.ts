import { countNoun } from "./fidelity.js";
import { SUPPORTED_LOREBOOK_VERSION } from "./novelai-lorebook.js";

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

export interface WorldInfoLorebook {
  /** The canonical entry shape, so one Entry Mapping serves both archives. */
  readonly lorebook: Record<string, unknown>;
  readonly fidelity: readonly string[];
}

/** True when the value is a SillyTavern World Info file rather than a NovelAI
 * Lorebook.
 *
 * The two are told apart by shape, not by file name: NovelAI numbers its format
 * and lists its entries, while World Info keys its entries by uid. */
export function isWorldInfo(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.lorebookVersion !== undefined) return false;
  return isRecord(value.entries) && !Array.isArray(value.entries);
}

/**
 * Turn a SillyTavern World Info file into the Lorebook shape the Entry Mapping
 * already reads.
 *
 * World Info carries retrieval machinery that 1667 has no place for: secondary
 * keys with their own AND and NOT logic, an insertion position and depth, a
 * firing probability, and recursion controls. A Fact is either always in
 * context or keyed on its own list, so those mechanisms are counted and named
 * rather than approximated into something that would fire at the wrong time.
 */
export function lorebookFromWorldInfo(value: unknown): WorldInfoLorebook {
  if (!isRecord(value) || !isRecord(value.entries)) {
    throw new Error("World Info must be an object with an entries object.");
  }

  const source = Object.values(value.entries);
  if (source.length > MAX_WORLD_INFO_ENTRIES) {
    throw new Error(
      `World Info has more than ${MAX_WORLD_INFO_ENTRIES.toLocaleString("en-US")} entries.`
    );
  }

  let secondaryKeyEntries = 0;
  let positionedEntries = 0;
  let chanceEntries = 0;
  let recursiveEntries = 0;
  let regexKeys = 0;
  let timedEntries = 0;
  let matchRuleEntries = 0;
  let groupedEntries = 0;
  let decoratedEntries = 0;
  let refusedEntries = 0;
  let vectorEntries = 0;
  let filteredEntries = 0;
  let macroEntries = 0;
  let paddedPatternKeys = 0;
  let scanSourceEntries = 0;
  const entries: Record<string, unknown>[] = [];

  for (const item of source) {
    if (!isRecord(item)) continue;

    if (Array.isArray(item.keysecondary) && item.keysecondary.length > 0) {
      secondaryKeyEntries += 1;
    }
    // Position 4 is "at depth"; the rest name a place in the prompt that a Fact
    // does not choose. Either way the Fact lands where 1667 puts Facts.
    if (item.position !== undefined && item.position !== null) positionedEntries += 1;
    if (item.useProbability === true && typeof item.probability === "number"
      && item.probability < 100) {
      chanceEntries += 1;
    }
    // `delayUntilRecursion` holds an entry back from the first scan, and it is
    // a number as often as a boolean.
    // Current files write numeric 0 for "no delay", so only true or a positive
    // level counts. Otherwise an ordinary file reports a loss it never had.
    const delayed = isPositive(item.delayUntilRecursion);
    if (item.recursion === true || item.excludeRecursion === true
      || item.preventRecursion === true || delayed) {
      recursiveEntries += 1;
    }
    // sticky, cooldown, and delay hold an entry in or out of context for a
    // number of turns. A Fact is judged fresh on every request.
    if (isPositive(item.sticky) || isPositive(item.cooldown) || isPositive(item.delay)) {
      timedEntries += 1;
    }
    // A Fact key matches case-insensitively on a whole key. An entry that asked
    // for something else will fire at different moments.
    if (item.caseSensitive === true || item.matchWholeWords === false) {
      matchRuleEntries += 1;
    }
    // These add places upstream looks for a key. A Fact scans the story
    // context, the instruction, and the selected text, and nothing else.
    if (SCAN_SOURCE_FIELDS.some((field) => item[field] === true)) {
      scanSourceEntries += 1;
    }
    // A vectorized entry is retrieved by meaning, not by a key, and usually
    // carries no keys at all. There is no such retrieval here.
    if (item.vectorized === true) vectorEntries += 1;
    // An entry can be limited to a character or to a kind of generation. A Fact
    // has no such condition, so an entry that was narrow becomes universal.
    if (hasEntries(item.triggers) || hasCharacterFilter(item.characterFilter)) {
      filteredEntries += 1;
    }
    // Entries sharing a group are exclusive upstream: one of them is used.
    // Independent Facts have no such contest, so they can all be active.
    if (typeof item.group === "string" && item.group.trim().length > 0) {
      groupedEntries += 1;
    }

    // SillyTavern reads a key written as /pattern/flags as a regular
    // expression. A Fact key is literal, so keeping one would leave a key that
    // fires only on the pattern's own text. Drop it and say so.
    // A leading @@decorator line is a control, not prose. Left in place it
    // would reach the model as text, and @@dont_activate would arrive as a
    // Fact the writer had switched off.
    const rawContent = typeof item.content === "string" ? item.content : "";
    // SillyTavern expands {{macros}} against a character and a chat before the
    // text is used. A World Info file carries neither, so the braces stay as
    // the writer wrote them and a macro key cannot match.
    if (hasMacro(rawContent) || sourceKeysHaveMacro(item.key)) macroEntries += 1;
    const decorated = readDecorators(rawContent);
    if (decorated.decorators.length > 0) decoratedEntries += 1;
    // Only the two exact controls are acted on, and @@activate wins when both
    // are present. Anything else — including a @@@ fallback line — leaves the
    // prose and is counted, but never decides activation. Reading a decorator
    // this import does not understand would either drop an entry the writer
    // kept or promote one they did not.
    const forced = decorated.decorators.includes("@@activate");
    if (!forced && decorated.decorators.includes("@@dont_activate")) {
      refusedEntries += 1;
      continue;
    }

    const sourceKeys = Array.isArray(item.key) ? item.key : [];
    const literalKeys = sourceKeys.filter((key) => {
      if (typeof key !== "string") return true;
      // An exact pattern is a pattern. A padded one is ambiguous: it is
      // slash-delimited but not anchored, so upstream may read it either way.
      // Keep it, because a dropped key can cost an entry its only trigger, and
      // name it so the writer is not left with a key that quietly never fires.
      if (isRegexKey(key)) {
        regexKeys += 1;
        return false;
      }
      if (key !== key.trim() && isRegexKey(key.trim())) paddedPatternKeys += 1;
      return true;
    });

    entries.push({
      text: decorated.content,
      displayName: typeof item.comment === "string" ? item.comment : "",
      keys: literalKeys,
      forceActivation: item.constant === true || forced,
      // World Info switches an entry off with `disable`; a Lorebook switches it
      // on with `enabled`. Read both so neither file loses the writer's choice.
      enabled: item.disable !== true
    });
  }

  const fidelity: string[] = [];
  if (secondaryKeyEntries > 0) {
    fidelity.push(
      `${secondaryKeyEntries} ${countNoun(secondaryKeyEntries, "entry", "entries")}`
        + " lost secondary keys; a fact keys on one list"
    );
  }
  if (positionedEntries > 0) {
    fidelity.push(
      `${positionedEntries} insertion ${countNoun(positionedEntries, "position")} omitted`
    );
  }
  if (chanceEntries > 0) {
    fidelity.push(
      `${chanceEntries} ${countNoun(chanceEntries, "entry", "entries")}`
        + " will always fire; a fact has no probability"
    );
  }
  if (recursiveEntries > 0) {
    fidelity.push(
      `${recursiveEntries} recursion ${countNoun(recursiveEntries, "setting")} omitted`
    );
  }
  if (regexKeys > 0) {
    fidelity.push(
      `${regexKeys} regular expression ${countNoun(regexKeys, "key")} dropped;`
        + " a fact key is literal"
    );
  }
  if (timedEntries > 0) {
    fidelity.push(
      `${timedEntries} ${countNoun(timedEntries, "entry", "entries")}`
        + " lost a timed effect; a fact is judged on every request"
    );
  }
  if (matchRuleEntries > 0) {
    fidelity.push(
      `${matchRuleEntries} ${countNoun(matchRuleEntries, "entry", "entries")}`
        + " lost a matching rule; a fact key matches a whole key without case"
    );
  }
  if (groupedEntries > 0) {
    fidelity.push(
      `${groupedEntries} grouped ${countNoun(groupedEntries, "entry", "entries")}`
        + " can now be active together; a group chose one"
    );
  }
  if (decoratedEntries > 0) {
    fidelity.push(
      `${decoratedEntries} activation ${countNoun(decoratedEntries, "decorator")} read and removed`
    );
  }
  if (refusedEntries > 0) {
    fidelity.push(
      `${refusedEntries} ${countNoun(refusedEntries, "entry", "entries")}`
        + " skipped for @@dont_activate"
    );
  }
  if (paddedPatternKeys > 0) {
    fidelity.push(
      `${paddedPatternKeys} spaced ${countNoun(paddedPatternKeys, "key")}`
        + " looks like a pattern and imports as literal text"
    );
  }
  if (scanSourceEntries > 0) {
    fidelity.push(
      `${scanSourceEntries} ${countNoun(scanSourceEntries, "entry", "entries")}`
        + " lost an extra scan source; a fact scans the story"
    );
  }
  if (macroEntries > 0) {
    fidelity.push(
      `${macroEntries} ${countNoun(macroEntries, "entry", "entries")}`
        + " kept a {{macro}} unexpanded; a fact carries no character or chat"
    );
  }
  if (vectorEntries > 0) {
    fidelity.push(
      `${vectorEntries} vectorized ${countNoun(vectorEntries, "entry", "entries")}`
        + " lost retrieval by meaning; a fact is always on or keyed"
    );
  }
  if (filteredEntries > 0) {
    fidelity.push(
      `${filteredEntries} ${countNoun(filteredEntries, "entry", "entries")}`
        + " lost a character or trigger filter and now applies everywhere"
    );
  }
  // True of every entry, whatever the file asked for, so it is stated once
  // rather than counted.
  fidelity.push("a fact key matches a whole key and ignores letter case");
  fidelity.push("scan depth, order, and other World Info settings omitted");

  return {
    lorebook: { lorebookVersion: SUPPORTED_LOREBOOK_VERSION, entries, categories: [] },
    fidelity
  };
}

/** `/pattern/flags`, the form SillyTavern reads as a regular expression.
 *
 * A key is only a pattern when the pattern compiles. `/(/` looks like one and
 * is literal text upstream, so treating it as a pattern would delete a key that
 * works. When in doubt the key stays. */
function isRegexKey(key: string): boolean {
  const match = /^\/(.+)\/([a-z]*)$/u.exec(key);
  if (match === null) return false;
  const [, pattern, flags] = match as unknown as [string, string, string];
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

function hasEntries(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function hasCharacterFilter(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return hasEntries(value.names) || hasEntries(value.tags);
}

/** Read the leading @@decorator lines and return the content without them.
 *
 * A decorator is honoured only when the line is exactly the control. Anything
 * else is still a control line and still leaves the prose, but it does not get
 * to promote a keyed entry to always active on a guess. */
function readDecorators(content: string): {
  readonly decorators: readonly string[];
  readonly content: string;
} {
  const lines = content.split("\n");
  const decorators: string[] = [];
  let index = 0;
  while (index < lines.length && lines[index]!.startsWith("@@")) {
    decorators.push(lines[index]!.replace(/\r$/u, ""));
    index += 1;
  }
  return { decorators, content: lines.slice(index).join("\n") };
}

function hasMacro(value: string): boolean {
  return /\{\{[^}]+\}\}/u.test(value);
}

function sourceKeysHaveMacro(value: unknown): boolean {
  return Array.isArray(value)
    && value.some((key) => typeof key === "string" && hasMacro(key));
}

function isPositive(value: unknown): boolean {
  return typeof value === "number" ? value > 0 : value === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
