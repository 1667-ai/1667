import type { FactActivation, FactPriority } from "./fact-activation.js";
import type { StoryFact } from "./types.js";

/**
 * Every field a writer can change on a Fact through the editor or a
 * `patchFact` mutation, normalized to the values equality compares by. One
 * closed record for this, instead of each caller hand-listing the fields it
 * cares about: a new editable Fact field is added here once, and every
 * comparison and projection that derives from `FactDraft` is then forced by
 * the compiler to account for it.
 */
export interface FactDraft {
  readonly tag: string | null;
  readonly activation: FactActivation;
  readonly keys: readonly string[];
  readonly priority: FactPriority;
  readonly budgetTokens: number | undefined;
  readonly text: string;
}

/** The draft a brand-new, unsaved Fact starts from. */
export const EMPTY_FACT_DRAFT: FactDraft = {
  tag: null,
  activation: "always",
  keys: [],
  priority: "normal",
  budgetTokens: undefined,
  text: ""
};

/** Project a stored Fact into its draft shape. `priority` defaults the same
 *  way it decodes (see shared/types.ts: absent means "normal"). */
export function factDraftOf(fact: StoryFact): FactDraft {
  return {
    tag: fact.tag,
    activation: fact.activation,
    keys: [...fact.keys],
    priority: fact.priority ?? "normal",
    budgetTokens: fact.budgetTokens,
    text: fact.text
  };
}

/** Field-wise equality over every `FactDraft` field. A caller comparing two
 *  Facts (or a Fact against a draft) always goes through this rather than
 *  listing fields itself, so a field this function does not know about
 *  cannot exist. */
export function sameFactDraft(left: FactDraft, right: FactDraft): boolean {
  return left.tag === right.tag
    && left.activation === right.activation
    && left.priority === right.priority
    && left.budgetTokens === right.budgetTokens
    && left.text === right.text
    && left.keys.length === right.keys.length
    && left.keys.every((key, index) => key === right.keys[index]);
}
