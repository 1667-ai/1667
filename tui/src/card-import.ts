import {
  factImportRequestBytes,
  factsFromCharacterCard,
  parseCharacterCard,
  type CharacterCardSections
} from "../../shared/character-card.js";
import type { FactInput } from "../../shared/types.js";
import { terminalLineText } from "../../shared/terminal-text.js";
import { MAX_JSON_BODY_BYTES } from "../../shared/types.js";

const SECTION_NAMES = ["description", "personality", "scenario"] as const;

export interface CardImportPlan {
  readonly name: string;
  readonly facts: readonly FactInput[];
  readonly used: readonly string[];
  readonly skipped: readonly string[];
}

/** Convert one character-card file's bytes into one atomic import plan. */
export function planCardImport(bytes: Uint8Array): CardImportPlan {
  const card = parseCharacterCard(bytes);
  const used = SECTION_NAMES.filter((section) => card[section].trim().length > 0);
  const skipped = SECTION_NAMES.filter((section) => card[section].trim().length === 0);
  const sections: CharacterCardSections = { name: card.name };
  for (const section of used) sections[section] = card[section];
  const facts = factsFromCharacterCard(sections);
  if (factImportRequestBytes(facts) > MAX_JSON_BODY_BYTES) {
    throw new Error(
      `The card converts to ${facts.length} facts that exceed the 1 MB request limit; shorten the character text.`
    );
  }
  return { name: card.name, facts, used, skipped };
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
