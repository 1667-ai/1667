import { countNoun } from "./fidelity.js";
import { SUPPORTED_LOREBOOK_VERSION } from "./novelai-lorebook.js";

/** A World Info file can hold far more entries than a story has room for. The
 * mapping bounds the Facts; this bounds the reading that gets there. */
const MAX_WORLD_INFO_ENTRIES = 10_000;

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
    const delayed = item.delayUntilRecursion !== undefined
      && item.delayUntilRecursion !== false
      && item.delayUntilRecursion !== null;
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

    // SillyTavern reads a key written as /pattern/flags as a regular
    // expression. A Fact key is literal, so keeping one would leave a key that
    // fires only on the pattern's own text. Drop it and say so.
    const sourceKeys = Array.isArray(item.key) ? item.key : [];
    const literalKeys = sourceKeys.filter((key) => {
      if (typeof key !== "string" || !isRegexKey(key)) return true;
      regexKeys += 1;
      return false;
    });

    entries.push({
      text: typeof item.content === "string" ? item.content : "",
      displayName: typeof item.comment === "string" ? item.comment : "",
      keys: literalKeys,
      forceActivation: item.constant === true,
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
  fidelity.push("scan depth, order, and group weighting omitted");

  return {
    lorebook: { lorebookVersion: SUPPORTED_LOREBOOK_VERSION, entries, categories: [] },
    fidelity
  };
}

/** `/pattern/flags`, the form SillyTavern reads as a regular expression. */
function isRegexKey(key: string): boolean {
  return /^\/.+\/[dgimsuvy]*$/u.test(key);
}

function isPositive(value: unknown): boolean {
  return typeof value === "number" ? value > 0 : value === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
