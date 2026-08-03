import { MAX_AUTHOR_BRIEF_CHARS } from "../../shared/author-brief.js";
import { MAX_STORY_FACTS_BUDGET_TOKENS } from "../../shared/fact-budget.js";
import { unicodeScalarLength } from "../../shared/unicode.js";
import type { StoryPayload } from "../../shared/types.js";
import type { SamplingPhraseBiasEntryV2 } from "../../shared/settings-v2-types.js";
import type { StoryApi } from "./api.js";
import { formatFactBudget, parseBudgetText } from "./fact-editor-draft.js";
import {
  formatBannedStringsText,
  formatPhraseBiasText,
  parseBannedStringsText,
  parsePhraseBiasText
} from "./story-sampling-draft.js";

/**
 * A story-level scalar saved straight to the story, with no field beyond its
 * own text to reconcile — unlike the Author's Note, which also carries a
 * depth. Author Brief, the Facts budget, and the story's own phrase bias and
 * banned strings (issue #341, each its own list-shaped field — see
 * story-sampling-draft.ts for the line-per-entry text format) are the ones
 * today.
 *
 * Before this table, the next one of these cost six edits across five files
 * — open, validate, save, reconcile, the `InlineEditorTarget` union member,
 * and the `targetExists` disjunction — and the one most likely to be
 * forgotten, `targetExists`, failed silently by leaving a dead editor open
 * (issue #281 review finding B). The next story-level scalar is a row here.
 */
export type StoryScalarField = "author-brief" | "facts-budget" | "phrase-bias" | "banned-strings";

/** What `validate` hands `save` and `toast` — not always the submitted text
 *  verbatim: the Facts budget validates into a parsed token count, and
 *  phrase bias/banned strings validate into their parsed entry lists. */
interface StoryScalarFieldValue {
  "author-brief": string;
  "facts-budget": number | undefined;
  "phrase-bias": readonly SamplingPhraseBiasEntryV2[];
  "banned-strings": readonly string[];
}

export interface StoryScalarFieldSpec<F extends StoryScalarField> {
  readonly title: string;
  readonly placeholder: string;
  /** The field's current authoritative value, as composer text. */
  read(payload: StoryPayload): string;
  validate(submitted: string):
    | { ok: true; value: StoryScalarFieldValue[F] }
    | { ok: false; toast: string };
  save(api: StoryApi, storyId: string, value: StoryScalarFieldValue[F]): Promise<StoryPayload>;
  toast(value: StoryScalarFieldValue[F]): string;
}

const STORY_SCALAR_FIELDS: { [F in StoryScalarField]: StoryScalarFieldSpec<F> } = {
  "author-brief": {
    title: "author brief",
    placeholder: "Override the machine-wide author brief for this story. ⌃s keeps it.",
    read: (payload) => payload.authorBrief ?? "",
    validate: (submitted) => (
      unicodeScalarLength(submitted, MAX_AUTHOR_BRIEF_CHARS) > MAX_AUTHOR_BRIEF_CHARS
        ? {
            ok: false,
            toast: `Author Brief must contain at most ${MAX_AUTHOR_BRIEF_CHARS.toLocaleString()} Unicode scalar values.`
          }
        : { ok: true, value: submitted }
    ),
    save: (api, storyId, value) => api.setAuthorBrief(storyId, value),
    toast: (value) => (value.trim().length === 0 ? "Author Brief cleared" : "Author Brief saved")
  },
  "facts-budget": {
    title: "facts budget",
    placeholder: "Cap the combined estimated tokens of every Fact in a request. Empty means uncapped.",
    read: (payload) => formatFactBudget(payload.factsBudgetTokens),
    validate: (submitted) => {
      const parsed = parseBudgetText(submitted, MAX_STORY_FACTS_BUDGET_TOKENS, "facts budget");
      return parsed.ok ? { ok: true, value: parsed.budgetTokens } : parsed;
    },
    save: (api, storyId, value) => api.setFactsBudget(storyId, value ?? null),
    toast: (value) => (value === undefined ? "facts budget cleared" : "facts budget saved")
  },
  "phrase-bias": {
    title: "phrase bias",
    placeholder: "Bias phrases for this story only, one \"phrase: weight\" per line (weight −100..100)."
      + " Adds to the profile's own phrase bias; a story entry overrides a matching profile entry. ⌃s keeps it.",
    read: (payload) => formatPhraseBiasText(payload.phraseBias ?? []),
    validate: (submitted) => parsePhraseBiasText(submitted),
    save: (api, storyId, value) => api.setPhraseBias(storyId, value),
    toast: (value) => (value.length === 0 ? "phrase bias cleared" : "phrase bias saved")
  },
  "banned-strings": {
    title: "banned strings",
    placeholder: "Ban strings for this story only, one per line."
      + " Adds to the profile's own banned strings. ⌃s keeps it.",
    read: (payload) => formatBannedStringsText(payload.bannedStrings ?? []),
    validate: (submitted) => parseBannedStringsText(submitted),
    save: (api, storyId, value) => api.setBannedStrings(storyId, value),
    toast: (value) => (value.length === 0 ? "banned strings cleared" : "banned strings saved")
  }
};

/** Look up a field's spec through a generic call, not a direct index — a
 *  direct `STORY_SCALAR_FIELDS[field]` index with a plain `StoryScalarField`
 *  key returns a *union* of the two specs, and calling `.save` on that union
 *  cannot typecheck (the union's call signature contravariantly intersects
 *  the two value types). Calling this generic instead keeps `field`, the
 *  spec, and its `value` type correlated end to end from `validate` through
 *  `save` and `toast`. */
export function storyScalarFieldSpec<F extends StoryScalarField>(field: F): StoryScalarFieldSpec<F> {
  return STORY_SCALAR_FIELDS[field];
}
