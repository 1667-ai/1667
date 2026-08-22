import { canonicalJson } from "../../server/canonical-json.js";
import { MAX_WRITING_OBJECT_BYTES } from "../../shared/settings-v5-limits.js";
import {
  updateSettingsDocumentV5,
  updateSettingsWritingField
} from "../../shared/settings-document-update.js";
import {
  WRITING_PROMPT_FIELD_IDS,
  writingPromptFieldDefinition,
  writingPromptSettingsFromAuthorBrief,
  type WritingPromptFieldDefinition,
  type WritingPromptFieldId,
  type WritingPromptSettings
} from "../../shared/settings-v5-writing.js";
import { hasUnpairedSurrogate, unicodeScalarLength } from "../../shared/unicode.js";
import {
  settingsTextDraftWithGeneration,
  type SettingsTextDraft
} from "./settings-text.js";

const UTF8 = new TextEncoder();

/** Read the complete writing object from the editable document. */
export function draftWriting(draft: SettingsTextDraft): WritingPromptSettings {
  return draft.document?.writing
    ?? writingPromptSettingsFromAuthorBrief(draft.generation.systemPrompt);
}

export function settingsTextDraftWithWritingField(
  draft: SettingsTextDraft,
  field: WritingPromptFieldId,
  value: string
): SettingsTextDraft {
  if (draft.document === null) {
    if (field !== "defaultAuthorBrief") return draft;
    return {
      ...draft,
      generation: { ...draft.generation, systemPrompt: value }
    };
  }
  const document = updateSettingsWritingField(draft.document, field, value);
  if (field !== "defaultAuthorBrief") return { ...draft, document };
  return settingsTextDraftWithGeneration(
    { ...draft, document },
    { ...draft.generation, systemPrompt: value }
  );
}

/** Keep local edits. Adopt newer remote values for fields the draft did not change. */
export function mergeUneditedWritingPrompts(
  local: WritingPromptSettings,
  base: WritingPromptSettings,
  remote: WritingPromptSettings
): WritingPromptSettings {
  const merged = { ...local };
  for (const field of WRITING_PROMPT_FIELD_IDS) {
    if (local[field] === base[field]) merged[field] = remote[field];
  }
  return merged;
}

export function settingsTextDraftWithMergedWriting(
  draft: SettingsTextDraft,
  base: SettingsTextDraft,
  remote: SettingsTextDraft
): SettingsTextDraft {
  if (draft.document === null || base.document === null || remote.document === null) {
    return draft;
  }
  const writing = mergeUneditedWritingPrompts(
    draft.document.writing,
    base.document.writing,
    remote.document.writing
  );
  if (sameWriting(writing, draft.document.writing)) return draft;
  const document = updateSettingsDocumentV5(draft.document, { writing });
  // Rebase only the writing fields that changed. Re-projecting the complete
  // document here would also replace unrelated local sampling and cache
  // drafts with the remote profile values.
  return {
    ...draft,
    document,
    generation: writing.defaultAuthorBrief === draft.generation.systemPrompt
      ? draft.generation
      : { ...draft.generation, systemPrompt: writing.defaultAuthorBrief }
  };
}

export function validateWritingPromptValue(
  definition: WritingPromptFieldDefinition,
  value: string,
  writing: WritingPromptSettings
): string | null {
  if (hasUnpairedSurrogate(value)) {
    return `${definition.title} has an unpaired Unicode surrogate.`;
  }
  if (unicodeScalarLength(value, definition.maxScalars) > definition.maxScalars) {
    return `${definition.title} must contain at most ${definition.maxScalars.toLocaleString("en-US")} Unicode scalar values.`;
  }
  const next = { ...writing, [definition.field]: value };
  const encoded = writingObjectBytes(next);
  if (encoded === null) {
    return `${definition.title} has an unpaired Unicode surrogate.`;
  }
  if (encoded > MAX_WRITING_OBJECT_BYTES) {
    return `writing prompts exceed their ${MAX_WRITING_OBJECT_BYTES.toLocaleString("en-US")}-byte canonical JSON limit.`;
  }
  return null;
}

export function writingPromptBudgetStatus(
  definition: WritingPromptFieldDefinition,
  value: string,
  writing: WritingPromptSettings,
  maxWidth: number
): { text: string; role: "danger text" | "context note" } | undefined {
  const error = validateWritingPromptValue(definition, value, writing);
  if (error !== null) {
    const overScalar = unicodeScalarLength(value, definition.maxScalars) > definition.maxScalars;
    const candidates = overScalar
      ? [
          `· max is ${definition.maxScalars.toLocaleString("en-US")} Unicode scalar values`,
          `· max is ${definition.maxScalars.toLocaleString("en-US")} scalar values`,
          `· max is ${definition.maxScalars.toLocaleString("en-US")}`
        ]
      : [
          `· writing budget is ${MAX_WRITING_OBJECT_BYTES.toLocaleString("en-US")} bytes`,
          `· writing budget exceeded`
        ];
    const text = candidates.find((candidate) => [...candidate].length <= maxWidth)
      ?? candidates.at(-1)!;
    return { text, role: "danger text" };
  }
  const encoded = writingObjectBytes({ ...writing, [definition.field]: value });
  if (encoded === null) return undefined;
  const remaining = Math.max(0, MAX_WRITING_OBJECT_BYTES - encoded);
  const candidates = [
    `· ${remaining.toLocaleString("en-US")} writing bytes left`,
    `· ${remaining.toLocaleString("en-US")} bytes left`
  ];
  const text = candidates.find((candidate) => [...candidate].length <= maxWidth);
  return text === undefined ? undefined : { text, role: "context note" };
}

export function writingFieldDefinition(field: WritingPromptFieldId): WritingPromptFieldDefinition {
  return writingPromptFieldDefinition(field);
}

function sameWriting(left: WritingPromptSettings, right: WritingPromptSettings): boolean {
  return WRITING_PROMPT_FIELD_IDS.every((field) => left[field] === right[field]);
}

function writingObjectBytes(writing: WritingPromptSettings): number | null {
  try {
    return UTF8.encode(canonicalJson(writing)).byteLength;
  } catch {
    return null;
  }
}
