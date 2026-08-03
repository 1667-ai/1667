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

type FieldEquality<T> = (left: T, right: T) => boolean;

function sameFactKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

/** One equality function per `FactDraft` field, typed as a mapped type over
 *  `keyof FactDraft` — so a field added to `FactDraft` without a matching
 *  entry here fails to compile, instead of `sameFactDraft` silently treating
 *  it as always equal (issue #281 review finding A). This is the table
 *  `sameFactDraft` folds over below; nothing reads it directly. */
const FACT_DRAFT_EQUALITY: { [K in keyof FactDraft]: FieldEquality<FactDraft[K]> } = {
  tag: (left, right) => left === right,
  activation: (left, right) => left === right,
  keys: sameFactKeys,
  priority: (left, right) => left === right,
  budgetTokens: (left, right) => left === right,
  text: (left, right) => left === right
};

/** Every `FactDraft` field name, read from `FACT_DRAFT_EQUALITY` so the list
 *  exists in exactly one place. Exported for a caller that must visit every
 *  field for a different reason than comparing two — writing a draft into an
 *  editor, say — so it reuses this instead of re-enumerating `FactDraft`'s
 *  fields by hand a second time (see tui/src/fact-editor-policy.ts's
 *  `applyFactDraftToEditor`). */
export const FACT_DRAFT_FIELDS: ReadonlyArray<keyof FactDraft> =
  Object.keys(FACT_DRAFT_EQUALITY) as Array<keyof FactDraft>;

function factDraftFieldEqual<K extends keyof FactDraft>(
  field: K,
  left: FactDraft,
  right: FactDraft
): boolean {
  return FACT_DRAFT_EQUALITY[field](left[field], right[field]);
}

/** Field-wise equality over every `FactDraft` field, folded from
 *  `FACT_DRAFT_EQUALITY` rather than hand-listed. A caller comparing two
 *  Facts (or a Fact against a draft) always goes through this rather than
 *  listing fields itself, so a field `FACT_DRAFT_EQUALITY` does not have an
 *  entry for cannot compile, let alone silently compare as always-equal. */
export function sameFactDraft(left: FactDraft, right: FactDraft): boolean {
  return FACT_DRAFT_FIELDS.every((field) => factDraftFieldEqual(field, left, right));
}
