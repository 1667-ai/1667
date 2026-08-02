import {
  factsFromCharacterCard,
  parseCharacterCard,
  type CharacterCardSections
} from "./character-card.js";
import { entriesFromCharacterBook } from "./character-book.js";
import { importEntries } from "./lorebook-entry.js";
import { countNoun } from "./fidelity.js";
import { factImportRequestBytes, MAX_FACTS, MAX_JSON_BODY_BYTES, type FactInput } from "./types.js";

const SECTION_NAMES = ["description", "personality", "scenario"] as const;

export interface CardImportPlan {
  readonly name: string;
  readonly facts: readonly FactInput[];
  readonly used: readonly string[];
  readonly skipped: readonly string[];
  /** The Fidelity Report: any Character Facts or `character_book` Facts that
   * did not fit the story's remaining room, V3 card fields that do not
   * import, and any `character_book` losses. Empty for an ordinary V1 or V2
   * card with no character book and room to spare. */
  readonly fidelity: readonly string[];
}

/** Convert one character-card file's bytes into one atomic import plan.
 *
 * `room` is how many more Facts the target story can hold. Both the
 * Character Facts and the `character_book` Facts are bounded by it — the
 * same 128-fact ceiling `factsFromEntries` applies to a lorebook import —
 * and by the 1 MB request the caller sends. The Character Facts are the
 * first claim on the room; whatever they leave, if anything, is what the
 * `character_book` gets. */
export function planCardImport(bytes: Uint8Array, room: number): CardImportPlan {
  const card = parseCharacterCard(bytes);
  const used = SECTION_NAMES.filter((section) => card[section].trim().length > 0);
  const skipped = SECTION_NAMES.filter((section) => card[section].trim().length === 0);
  const sections: CharacterCardSections = { name: card.name };
  for (const section of used) sections[section] = card[section];
  const allCharacterFacts = factsFromCharacterCard(sections);
  if (factImportRequestBytes(allCharacterFacts) > MAX_JSON_BODY_BYTES) {
    throw new Error(
      `The card converts to ${allCharacterFacts.length} facts that exceed the 1 MB request limit; shorten the character text.`
    );
  }

  const fidelity: string[] = [];

  // A card's own text needing more than 128 facts is refused above, by
  // `factsFromCharacterCard`. This is a different ceiling: the *story's*
  // remaining room, which the Character Facts had never been bounded by, so
  // a nearly-full story took a hard 409 from the Fact ceiling instead of
  // degrading with a reason, the way an oversized character_book already
  // does.
  const roomCap = Math.max(0, Math.min(room, MAX_FACTS));
  let characterFacts = allCharacterFacts;
  if (characterFacts.length > roomCap) {
    const droppedCount = characterFacts.length - roomCap;
    characterFacts = characterFacts.slice(0, roomCap);
    fidelity.push(`${droppedCount} ${countNoun(droppedCount, "fact")} did not fit the 128-fact limit`);
  }

  let bookFacts: readonly FactInput[] = [];
  if (card.characterBook !== undefined) {
    // The Character Facts above import in full or the card is already
    // refused; whatever room and request body they leave is what the book
    // gets. This slightly over-counts the shared JSON envelope, which only
    // makes the reservation more conservative, never less.
    const bookRoom = Math.max(0, roomCap - characterFacts.length);
    const bookBudget = Math.max(0, MAX_JSON_BODY_BYTES - factImportRequestBytes(characterFacts));
    const imported = importEntries(entriesFromCharacterBook(card.characterBook), bookRoom, bookBudget);
    bookFacts = imported.facts;
    fidelity.push(...imported.fidelity);
  }
  fidelity.push(...card.fidelity);

  return {
    name: card.name,
    facts: [...characterFacts, ...bookFacts],
    used,
    skipped,
    fidelity
  };
}
