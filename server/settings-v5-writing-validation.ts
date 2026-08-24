import { canonicalJson } from "./canonical-json.js";
import {
  SettingsFormatError,
  requireBoundedSettingsString
} from "./settings-v2-scalars.js";
import { closedRecord, closedShape } from "./story-wire-validation.js";
import { hasUnpairedSurrogate } from "../shared/unicode.js";
import { MAX_WRITING_OBJECT_BYTES } from "../shared/settings-v5-limits.js";
import {
  WRITING_PROMPT_FIELD_DEFINITIONS,
  WRITING_PROMPT_FIELD_IDS,
  type WritingPromptSettings
} from "../shared/settings-v5-writing.js";

const WRITING = closedShape([...WRITING_PROMPT_FIELD_IDS]);

export function parseWritingPromptSettings(
  value: unknown,
  label = "settings document.writing"
): WritingPromptSettings {
  const writing = closedRecord(value, label, WRITING);
  const parsed = {} as { -readonly [Field in keyof WritingPromptSettings]: string };
  for (const definition of WRITING_PROMPT_FIELD_DEFINITIONS) {
    const fieldLabel = `${label}.${definition.field}`;
    const fieldValue = writing[definition.field];
    if (typeof fieldValue !== "string") {
      throw new SettingsFormatError(`${fieldLabel} must be a string`);
    }
    if (hasUnpairedSurrogate(fieldValue)) {
      throw new SettingsFormatError(`${fieldLabel} has an unpaired Unicode surrogate`);
    }
    parsed[definition.field] = requireBoundedSettingsString(
      fieldValue,
      fieldLabel,
      definition.maxScalars
    );
  }
  const settings: WritingPromptSettings = parsed;
  assertWritingObjectBudget(settings, label);
  return settings;
}

export function assertWritingObjectBudget(
  writing: WritingPromptSettings,
  label = "settings document.writing"
): void {
  const bytes = Buffer.byteLength(canonicalJson(writing), "utf8");
  if (bytes > MAX_WRITING_OBJECT_BYTES) {
    throw new SettingsFormatError(
      `${label} exceeds its ${MAX_WRITING_OBJECT_BYTES}-byte canonical JSON limit`
    );
  }
}
