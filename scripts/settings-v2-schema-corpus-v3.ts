import { canonicalJson } from "../server/canonical-json.js";
import { formatSettingsDocumentV3 } from "../server/settings-v3-codec.js";
import { convertSettingsDocumentV2ToV3 } from "../server/settings-v3-conversion.js";
import {
  INITIAL_SETTINGS_DOCUMENT_V3,
  INITIAL_SETTINGS_DOCUMENT_V3_TEXT,
  INITIAL_SETTINGS_STATE_V3_TEXT
} from "../server/settings-v3-default.js";
import { convertGenerationSettingsV1 } from "../server/settings-v2-conversion.js";
import type { GenerationSettings } from "../shared/types.js";
import type { SettingsDocumentV3 } from "../shared/settings-v2-types.js";
import type { SettingsV2CorpusCase } from "./settings-v2-schema-corpus.js";

/** Schema 3's corpus cases, kept separate from the schema-2 corpus builder so
 * that already-large file does not grow further. Merged into the returned
 * array by `settingsV2Corpus`. */
export function settingsV2CorpusV3(): SettingsV2CorpusCase[] {
  const migrated = convertSettingsDocumentV2ToV3(convertGenerationSettingsV1(openAiSettings()));
  const model = migrated.models[migrated.profiles[migrated.routing.default]!.modelId]!;
  const withCeilingWithoutSupported: SettingsDocumentV3 = {
    ...INITIAL_SETTINGS_DOCUMENT_V3,
    models: {
      ...INITIAL_SETTINGS_DOCUMENT_V3.models,
      "builtin:dry-run": {
        ...INITIAL_SETTINGS_DOCUMENT_V3.models["builtin:dry-run"]!,
        capabilities: {
          ...INITIAL_SETTINGS_DOCUMENT_V3.models["builtin:dry-run"]!.capabilities,
          imageTokenCeiling: 1_200
        }
      }
    }
  };
  const withSupportedCeiling: SettingsDocumentV3 = {
    ...migrated,
    models: {
      ...migrated.models,
      [migrated.profiles[migrated.routing.default]!.modelId]: {
        ...model,
        capabilities: { ...model.capabilities, imageInput: "supported", imageTokenCeiling: 1_200 }
      }
    }
  };
  return [
    validText("initial-document-v3", "document", INITIAL_SETTINGS_DOCUMENT_V3_TEXT),
    validText("initial-state-v3", "state", INITIAL_SETTINGS_STATE_V3_TEXT),
    valid("converted-v3", "document", migrated),
    valid("document-v3-with-supported-ceiling", "document", withSupportedCeiling),
    // The schema alone has no `dependentRequired` expression for "the
    // ceiling requires imageInput === supported" (the shared `closed()`
    // helper does not support it), so this document is schema-valid and
    // codec-invalid, the same shape as `document-reasoning-on-model-returning-none`.
    invalid(
      "document-v3-ceiling-without-supported",
      "document",
      withCeilingWithoutSupported,
      true
    ),
    // `imageInput` is a required schema-3 capability key, so a document
    // missing it fails the schema itself.
    invalid("document-v3-missing-image-input", "document", {
      ...INITIAL_SETTINGS_DOCUMENT_V3,
      models: {
        ...INITIAL_SETTINGS_DOCUMENT_V3.models,
        "builtin:dry-run": {
          ...INITIAL_SETTINGS_DOCUMENT_V3.models["builtin:dry-run"]!,
          capabilities: withoutImageInput(
            INITIAL_SETTINGS_DOCUMENT_V3.models["builtin:dry-run"]!.capabilities as unknown as Record<string, unknown>
          )
        }
      }
    }, false)
  ];
}

function withoutImageInput(capabilities: Record<string, unknown>): Record<string, unknown> {
  const { imageInput: _dropped, ...rest } = capabilities;
  return rest;
}

function openAiSettings(): GenerationSettings {
  return {
    provider: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o",
    apiKeyEnv: "OPENAI_API_KEY",
    temperature: 0.7,
    maxTokens: 2_048,
    systemPrompt: "Continue in the established voice.",
    contextWindow: 32_768
  };
}

/** Every "valid" case built here is a document; state cases go through
 *  `validText` directly since only the frozen initial state is exercised. */
function valid(name: string, kind: "document", value: SettingsDocumentV3): SettingsV2CorpusCase {
  return validText(name, kind, formatSettingsDocumentV3(value));
}

function validText(
  name: string,
  kind: SettingsV2CorpusCase["kind"],
  text: string
): SettingsV2CorpusCase {
  return { name, kind, valid: true, schemaValid: true, text };
}

function invalid(
  name: string,
  kind: SettingsV2CorpusCase["kind"],
  value: unknown,
  schemaValid: boolean
): SettingsV2CorpusCase {
  return { name, kind, valid: false, schemaValid, text: canonicalJson(value) };
}
