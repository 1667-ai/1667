import { canonicalJson } from "../server/canonical-json.js";
import {
  INITIAL_SETTINGS_DOCUMENT_V4_TEXT,
  INITIAL_SETTINGS_STATE_V4_TEXT
} from "../server/settings-v4-initial-vectors.js";

export interface SettingsV4CorpusCase {
  readonly kind: "document" | "state";
  readonly name: string;
  readonly text: string;
  readonly schemaValid: boolean;
}

interface CorpusDocument extends Record<string, unknown> {
  readonly profiles: Record<string, Record<string, unknown>>;
}

/** Small structural corpus for the schema-4 predecessor artifact. */
export function settingsV4Corpus(): readonly SettingsV4CorpusCase[] {
  const initialDocument = JSON.parse(INITIAL_SETTINGS_DOCUMENT_V4_TEXT) as CorpusDocument;
  const initialState = JSON.parse(INITIAL_SETTINGS_STATE_V4_TEXT) as Record<string, unknown>;
  const missingThinking = clone(initialDocument);
  delete missingThinking.profiles.default!.thinkingMode;
  const legacyEffort = clone(initialDocument);
  legacyEffort.profiles.default!.effort = "off";
  const extraStateField = clone(initialState);
  extraStateField.unexpected = true;
  return [
    {
      kind: "document",
      name: "initial-document-v4",
      text: INITIAL_SETTINGS_DOCUMENT_V4_TEXT,
      schemaValid: true
    },
    {
      kind: "state",
      name: "initial-state-v4",
      text: INITIAL_SETTINGS_STATE_V4_TEXT,
      schemaValid: true
    },
    {
      kind: "document",
      name: "missing-thinking-mode",
      text: canonicalJson(missingThinking),
      schemaValid: false
    },
    {
      kind: "document",
      name: "legacy-off-effort",
      text: canonicalJson(legacyEffort),
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
