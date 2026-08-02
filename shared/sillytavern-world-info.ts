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
    if (item.recursion === true || item.excludeRecursion === true
      || item.preventRecursion === true) {
      recursiveEntries += 1;
    }

    entries.push({
      text: typeof item.content === "string" ? item.content : "",
      displayName: typeof item.comment === "string" ? item.comment : "",
      keys: Array.isArray(item.key) ? item.key : [],
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
  fidelity.push("scan depth, order, and group weighting omitted");

  return {
    lorebook: { lorebookVersion: SUPPORTED_LOREBOOK_VERSION, entries, categories: [] },
    fidelity
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
