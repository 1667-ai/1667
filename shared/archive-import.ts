import { factsFromEntries, type LorebookImport } from "./lorebook-entry.js";
import { factsFromLorebook } from "./novelai-lorebook.js";
import { isWorldInfo, lorebookFromWorldInfo } from "./sillytavern-world-info.js";
import { looksLikeCharacterCard } from "./character-card.js";

export type { LorebookImport } from "./lorebook-entry.js";

/** Turn a parsed archive into Facts, whichever product wrote it.
 *
 * A SillyTavern World Info file becomes the canonical Lorebook entry shape
 * first, so the Entry Mapping below stays the only place an entry becomes a
 * Fact. Its own losses are named before the mapping names its own. */
export function factsFromArchive(
  value: unknown,
  room: number,
  bodyBudget?: number
): LorebookImport {
  // Recognise an archive before guessing at a card. A World Info file may carry
  // its own root name and description, which would otherwise read as a card.
  if (isWorldInfo(value)) return worldInfoFacts(value, room, bodyBudget);
  if (isRecord(value) && value.lorebookVersion !== undefined) {
    return factsFromLorebook(value, room, bodyBudget);
  }
  // A character card is .json as well, and it has its own door. Name that door
  // rather than refuse it as a lorebook with the wrong version.
  if (looksLikeCharacterCard(value)) {
    throw new Error(
      "this is a character card, not a lorebook · use 1667 import-card"
        + " or the 'import character card' command"
    );
  }
  return factsFromLorebook(value, room, bodyBudget);
}

function worldInfoFacts(
  value: unknown,
  room: number,
  bodyBudget?: number
): LorebookImport {
  const converted = lorebookFromWorldInfo(value);
  const imported = factsFromEntries(converted.entries, room, bodyBudget);
  return {
    facts: imported.facts,
    fidelity: [...imported.fidelity, ...converted.fidelity]
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
