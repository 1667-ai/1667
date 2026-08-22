import { canonicalJson } from "../server/canonical-json.js";
import {
  INITIAL_SETTINGS_DOCUMENT_V5_TEXT,
  INITIAL_SETTINGS_STATE_V5_TEXT
} from "../server/settings-v5-initial-vectors.js";
import {
  MAX_DEFAULT_CONTINUE_DIRECTION_SCALARS,
  MAX_WRITING_PROMPT_SCALARS
} from "../shared/settings-v5-limits.js";
import { WRITING_PROMPT_FIELD_IDS } from "../shared/settings-v5-writing.js";

export interface SettingsV5CorpusCase {
  readonly kind: "document" | "state";
  readonly name: string;
  readonly text: string;
  readonly schemaValid: boolean;
}

interface CorpusDocument extends Record<string, unknown> {
  readonly profiles: Record<string, Record<string, unknown>>;
  readonly writing: Record<string, string>;
}

export function settingsV5Corpus(): readonly SettingsV5CorpusCase[] {
  const initialDocument = JSON.parse(INITIAL_SETTINGS_DOCUMENT_V5_TEXT) as CorpusDocument;
  const initialState = JSON.parse(INITIAL_SETTINGS_STATE_V5_TEXT) as Record<string, unknown>;
  const missingReasoning = clone(initialDocument);
  delete missingReasoning.profiles.default!.generationReasoning;
  const legacyOff = clone(initialDocument);
  legacyOff.profiles.default!.generationReasoning = { kind: "legacy", effort: "off" };
  const independentWithoutMode = clone(initialDocument);
  independentWithoutMode.profiles.default!.generationReasoning = {
    kind: "independent",
    effort: "high"
  };
  const inferredPair = clone(initialDocument);
  inferredPair.profiles.default!.generationReasoning = {
    effort: "default",
    thinkingMode: "default"
  };
  const extraStateField = clone(initialState);
  extraStateField.unexpected = true;
  const missingWritingField = clone(initialDocument);
  delete missingWritingField.writing.asideGuidance;
  const overAuthorBrief = clone(initialDocument);
  overAuthorBrief.writing.defaultAuthorBrief = "a".repeat(MAX_WRITING_PROMPT_SCALARS + 1);
  const overContinue = clone(initialDocument);
  overContinue.writing.defaultContinueDirection = "a".repeat(
    MAX_DEFAULT_CONTINUE_DIRECTION_SCALARS + 1
  );
  const atAuthorBrief = clone(initialDocument);
  atAuthorBrief.writing.defaultAuthorBrief = "a".repeat(MAX_WRITING_PROMPT_SCALARS);
  const atContinue = clone(initialDocument);
  atContinue.writing.defaultContinueDirection = "a".repeat(MAX_DEFAULT_CONTINUE_DIRECTION_SCALARS);
  const nonBmp = clone(initialDocument);
  nonBmp.writing.rewriteGuidance = "𝄞";
  const allGuidance = clone(initialDocument);
  for (const field of WRITING_PROMPT_FIELD_IDS) {
    if (field === "defaultAuthorBrief" || field === "defaultContinueDirection") continue;
    allGuidance.writing[field] = `guidance for ${field}`;
  }
  return [
    {
      kind: "document",
      name: "initial-document-v5",
      text: INITIAL_SETTINGS_DOCUMENT_V5_TEXT,
      schemaValid: true
    },
    {
      kind: "state",
      name: "initial-state-v5",
      text: INITIAL_SETTINGS_STATE_V5_TEXT,
      schemaValid: true
    },
    {
      kind: "document",
      name: "legacy-off-effort",
      text: canonicalJson(legacyOff),
      schemaValid: true
    },
    {
      kind: "document",
      name: "all-writing-fields",
      text: canonicalJson(allGuidance),
      schemaValid: true
    },
    {
      kind: "document",
      name: "author-brief-at-limit",
      text: canonicalJson(atAuthorBrief),
      schemaValid: true
    },
    {
      kind: "document",
      name: "continue-direction-at-limit",
      text: canonicalJson(atContinue),
      schemaValid: true
    },
    {
      kind: "document",
      name: "non-bmp-guidance",
      text: canonicalJson(nonBmp),
      schemaValid: true
    },
    {
      kind: "document",
      name: "missing-generation-reasoning",
      text: canonicalJson(missingReasoning),
      schemaValid: false
    },
    {
      kind: "document",
      name: "independent-without-thinking-mode",
      text: canonicalJson(independentWithoutMode),
      schemaValid: false
    },
    {
      kind: "document",
      name: "reasoning-without-kind",
      text: canonicalJson(inferredPair),
      schemaValid: false
    },
    {
      kind: "document",
      name: "missing-writing-field",
      text: canonicalJson(missingWritingField),
      schemaValid: false
    },
    {
      kind: "document",
      name: "author-brief-over-limit",
      text: canonicalJson(overAuthorBrief),
      schemaValid: false
    },
    {
      kind: "document",
      name: "continue-direction-over-limit",
      text: canonicalJson(overContinue),
      schemaValid: false
    },
    {
      kind: "state",
      name: "unexpected-state-field",
      text: canonicalJson(extraStateField),
      schemaValid: false
    }
  ];
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
