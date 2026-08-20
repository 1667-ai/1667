import type {
  ModelCapabilitiesV3,
  ModelDefinitionV3,
  SettingsDocumentV2,
  SettingsDocumentV3
} from "../shared/settings-v2-types.js";
import { validateSettingsDocumentV3 } from "./settings-v3-validation.js";

/** Migrate a schema-2 settings document to schema 3, mechanically: every
 *  model gains the `imageInput` capability, a model whose connection uses
 *  the `dry-run` protocol gets `"unsupported"`, because dry run never calls
 *  a provider; every other model gets `"unknown"`. Exact built-in model
 *  knowledge decides support later, at resolution time
 *  (shared/image-input-capabilities.ts), not at migration time.
 *
 *  No production code path calls this. This release's settings writer
 *  always writes schema 2 (there is no successor settings writer in this
 *  build at all: `shared/image-input-release.ts`), so nothing in this build
 *  ever needs to produce a schema-3 document outside a test fixture
 *  standing in for a later release's write
 *  (test/settings-schema-successor.test.ts). The release that adds
 *  capability-override storage is the one that ships this writer, against
 *  the incoming value it will actually have in hand. */
export function convertSettingsDocumentV2ToV3(document: SettingsDocumentV2): SettingsDocumentV3 {
  const models: Record<string, ModelDefinitionV3> = {};
  for (const [id, model] of Object.entries(document.models)) {
    const isDryRun = document.connections[model.connectionId]?.protocol === "dry-run";
    const capabilities: ModelCapabilitiesV3 = {
      ...model.capabilities,
      imageInput: isDryRun ? "unsupported" : "unknown"
    };
    models[id] = { ...model, capabilities };
  }
  return validateSettingsDocumentV3({
    schemaVersion: 3,
    connections: document.connections,
    models,
    profiles: document.profiles,
    routing: document.routing,
    writing: document.writing,
    ...(document.settingsViewMode === undefined ? {} : { settingsViewMode: document.settingsViewMode })
  });
}
