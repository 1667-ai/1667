import {
  MAX_DEFAULT_CONTINUE_DIRECTION_SCALARS,
  MAX_WRITING_PROMPT_SCALARS
} from "./settings-v5-limits.js";

export const DEFAULT_AUTHOR_BRIEF =
  "Continue the story in its established voice.";
export const DEFAULT_CONTINUE_DIRECTION = "Continue the story.";

export const WRITING_PROMPT_FIELD_IDS = [
  "defaultAuthorBrief",
  "defaultContinueDirection",
  "rewriteGuidance",
  "titleGuidance",
  "summaryGuidance",
  "asideGuidance"
] as const;
export type WritingPromptFieldId = (typeof WRITING_PROMPT_FIELD_IDS)[number];

export type WritingPromptEmptyBehavior =
  | "omit-global-brief"
  | "reset-to-builtin"
  | "omit-block";

export type WritingPromptViewVisibility = "simple" | "advanced";

export const WRITING_PROMPT_ROW_IDS = [
  "default-author-brief",
  "default-continue-direction",
  "rewrite-guidance",
  "title-guidance",
  "summary-guidance",
  "aside-guidance"
] as const;
export type WritingPromptRowId = (typeof WRITING_PROMPT_ROW_IDS)[number];

export interface WritingPromptFieldDefinition {
  readonly row: WritingPromptRowId;
  readonly field: WritingPromptFieldId;
  readonly label: string;
  readonly title: string;
  readonly placeholder: string;
  readonly help: string;
  readonly maxScalars: number;
  readonly defaultValue: string;
  readonly emptyBehavior: WritingPromptEmptyBehavior;
  readonly view: WritingPromptViewVisibility;
}

const EMPTY_BEHAVIOR_HELP: Record<WritingPromptEmptyBehavior, string> = {
  "omit-global-brief": "Empty omits the global brief.",
  "reset-to-builtin": `Empty uses ${DEFAULT_CONTINUE_DIRECTION}`,
  "omit-block": "Empty adds no request block."
};

/** One table owns row ID, field key, title, placeholder, empty behavior,
 *  help text, and simple/advanced visibility. */
export const WRITING_PROMPT_FIELD_DEFINITIONS = [
  {
    row: "default-author-brief",
    field: "defaultAuthorBrief",
    label: "author brief",
    title: "Default Author Brief",
    placeholder: "Write the Default Author Brief…",
    help: "Default Author Brief for prose and story names. A story brief overrides it.",
    maxScalars: MAX_WRITING_PROMPT_SCALARS,
    defaultValue: DEFAULT_AUTHOR_BRIEF,
    emptyBehavior: "omit-global-brief",
    view: "simple"
  },
  {
    row: "default-continue-direction",
    field: "defaultContinueDirection",
    label: "continue",
    title: "Default Continue direction",
    placeholder: "Write the Default Continue direction…",
    help: "Default Continue direction for a new empty Continue request.",
    maxScalars: MAX_DEFAULT_CONTINUE_DIRECTION_SCALARS,
    defaultValue: DEFAULT_CONTINUE_DIRECTION,
    emptyBehavior: "reset-to-builtin",
    view: "simple"
  },
  {
    row: "rewrite-guidance",
    field: "rewriteGuidance",
    label: "rewrite",
    title: "Rewrite guidance",
    placeholder: "Write standing Rewrite guidance…",
    help: "Standing Rewrite guidance. This text cannot replace the Rewrite contract.",
    maxScalars: MAX_WRITING_PROMPT_SCALARS,
    defaultValue: "",
    emptyBehavior: "omit-block",
    view: "advanced"
  },
  {
    row: "title-guidance",
    field: "titleGuidance",
    label: "title",
    title: "Title guidance",
    placeholder: "Write standing Title guidance…",
    help: "Standing Title guidance for autoname requests. Title still uses the Utility Generation Profile.",
    maxScalars: MAX_WRITING_PROMPT_SCALARS,
    defaultValue: "",
    emptyBehavior: "omit-block",
    view: "advanced"
  },
  {
    row: "summary-guidance",
    field: "summaryGuidance",
    label: "summary",
    title: "Summary guidance",
    placeholder: "Write standing Summary guidance…",
    help: "Standing Summary guidance for summary-take and chapter-summary requests. Summary still uses the Utility Generation Profile.",
    maxScalars: MAX_WRITING_PROMPT_SCALARS,
    defaultValue: "",
    emptyBehavior: "omit-block",
    view: "advanced"
  },
  {
    row: "aside-guidance",
    field: "asideGuidance",
    label: "aside",
    title: "Aside guidance",
    placeholder: "Write standing Aside guidance…",
    help: "Standing Aside guidance. Aside still uses the Utility Generation Profile.",
    maxScalars: MAX_WRITING_PROMPT_SCALARS,
    defaultValue: "",
    emptyBehavior: "omit-block",
    view: "advanced"
  }
] as const satisfies readonly WritingPromptFieldDefinition[];

export type WritingPromptSettings = {
  readonly [Field in WritingPromptFieldId]: string;
};

export const DEFAULT_WRITING_PROMPT_SETTINGS: WritingPromptSettings = Object.freeze({
  defaultAuthorBrief: DEFAULT_AUTHOR_BRIEF,
  defaultContinueDirection: DEFAULT_CONTINUE_DIRECTION,
  rewriteGuidance: "",
  titleGuidance: "",
  summaryGuidance: "",
  asideGuidance: ""
});

/** Schema 2/3/4 and format-1 views project stored Author Brief plus schema-5
 *  defaults for every other writing field. */
export function writingPromptSettingsFromAuthorBrief(
  defaultAuthorBrief: string
): WritingPromptSettings {
  return {
    ...DEFAULT_WRITING_PROMPT_SETTINGS,
    defaultAuthorBrief
  };
}

export function writingPromptFieldDefinition(
  field: WritingPromptFieldId
): WritingPromptFieldDefinition {
  const definition = WRITING_PROMPT_FIELD_DEFINITIONS.find((entry) => entry.field === field);
  if (definition === undefined) {
    throw new Error(`Unknown writing prompt field: ${field}`);
  }
  return definition;
}

export function isWritingPromptRow(row: string): row is WritingPromptRowId {
  return WRITING_PROMPT_FIELD_DEFINITIONS.some((entry) => entry.row === row);
}

export function writingPromptFieldDefinitionForRow(
  row: WritingPromptRowId
): WritingPromptFieldDefinition {
  const definition = WRITING_PROMPT_FIELD_DEFINITIONS.find((entry) => entry.row === row);
  if (definition === undefined) {
    throw new Error(`Unknown writing prompt row: ${row}`);
  }
  return definition;
}

export function writingPromptEmptyHelp(behavior: WritingPromptEmptyBehavior): string {
  return EMPTY_BEHAVIOR_HELP[behavior];
}

export function writingPromptRowHelp(definition: WritingPromptFieldDefinition): string {
  return `${definition.help} ${writingPromptEmptyHelp(definition.emptyBehavior)}`;
}
