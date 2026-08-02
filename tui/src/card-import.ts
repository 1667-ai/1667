import {
  factImportRequestBytes,
  factsFromCharacterCard,
  parseCharacterCard,
  type CharacterCardSections
} from "../../shared/character-card.js";
import { entriesFromCharacterBook } from "../../shared/character-book.js";
import { factsFromEntries } from "../../shared/lorebook-entry.js";
import type { FactInput } from "../../shared/types.js";
import { terminalLineText } from "../../shared/terminal-text.js";
import { MAX_JSON_BODY_BYTES } from "../../shared/types.js";

const SECTION_NAMES = ["description", "personality", "scenario"] as const;

export interface CardImportPlan {
  readonly name: string;
  readonly facts: readonly FactInput[];
  readonly used: readonly string[];
  readonly skipped: readonly string[];
  /** The Fidelity Report: V3 card fields that do not import, and any
   * `character_book` losses. Empty for an ordinary V1 or V2 card with no
   * character book. */
  readonly fidelity: readonly string[];
}

/** Convert one character-card file's bytes into one atomic import plan.
 *
 * `room` is how many more Facts the target story can hold. The combined set
 * of Character Facts and `character_book` Facts is bounded by it, and by the
 * 1 MB request the caller sends. */
export function planCardImport(bytes: Uint8Array, room: number): CardImportPlan {
  const card = parseCharacterCard(bytes);
  const used = SECTION_NAMES.filter((section) => card[section].trim().length > 0);
  const skipped = SECTION_NAMES.filter((section) => card[section].trim().length === 0);
  const sections: CharacterCardSections = { name: card.name };
  for (const section of used) sections[section] = card[section];
  const characterFacts = factsFromCharacterCard(sections);
  if (factImportRequestBytes(characterFacts) > MAX_JSON_BODY_BYTES) {
    throw new Error(
      `The card converts to ${characterFacts.length} facts that exceed the 1 MB request limit; shorten the character text.`
    );
  }

  const fidelity: string[] = [];
  let bookFacts: readonly FactInput[] = [];
  if (card.characterBook !== undefined) {
    const book = entriesFromCharacterBook(card.characterBook);
    // The Character Facts above import in full or the card is already
    // refused; whatever room and request body they leave is what the book
    // gets. This slightly over-counts the shared JSON envelope, which only
    // makes the reservation more conservative, never less.
    const bookRoom = Math.max(0, room - characterFacts.length);
    const bookBudget = Math.max(0, MAX_JSON_BODY_BYTES - factImportRequestBytes(characterFacts));
    const imported = factsFromEntries(book.entries, bookRoom, bookBudget, book.sourceCount);
    bookFacts = imported.facts;
    fidelity.push(...imported.fidelity, ...book.fidelity);
  }
  if (card.ignoredFields !== undefined) fidelity.push(...card.ignoredFields);

  return {
    name: card.name,
    facts: [...characterFacts, ...bookFacts],
    used,
    skipped,
    fidelity
  };
}

/** Describe the plan for a toast or another concise status line. */
export function describeCardImport(plan: CardImportPlan): string {
  const count = `${plan.facts.length} fact${plan.facts.length === 1 ? "" : "s"}`;
  const used = joinWords(plan.used);
  const skipped = plan.skipped.length === 0
    ? ""
    : ` · ${joinWords(plan.skipped)} ${plan.skipped.length === 1 ? "was" : "were"} empty`;
  // The name is card content, and this string is drawn in a terminal.
  return `${count} for "${terminalLineText(plan.name)}" · ${used}${skipped}`;
}

function joinWords(values: readonly string[]): string {
  if (values.length === 0) return "no fields";
  if (values.length === 1) return values[0]!;
  return `${values.slice(0, -1).join(", ")} and ${values[values.length - 1]!}`;
}
