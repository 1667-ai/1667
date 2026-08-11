import type {
  ModelCapabilitiesV3,
  ModelDefinitionV3,
  SettingsDocumentV2,
  SettingsDocumentV3
} from "../shared/settings-v2-types.js";
import { validateSettingsDocumentV3 } from "./settings-v3-validation.js";
import { resolveImageInputActivation } from "../shared/image-input-release.js";

/** Migrate a schema-2 settings document to schema 3. Every model gains the
 *  `imageInput` capability: a model whose connection uses the `dry-run`
 *  protocol gets `"unsupported"`, because dry run never calls a provider;
 *  every other migrated model gets `"unknown"`. Exact built-in model
 *  knowledge decides support later, at resolution time
 *  (shared/image-input-capabilities.ts), not at migration time. */
export function convertSettingsDocumentV2ToV3(document: SettingsDocumentV2): SettingsDocumentV3 {
  const models: Record<string, ModelDefinitionV3> = {};
  for (const [id, model] of Object.entries(document.models)) {
    const connection = document.connections[model.connectionId];
    const isDryRun = connection?.protocol === "dry-run";
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
    writing: document.writing
  });
}

export interface SettingsWriteSchemaOptions {
  /** Defaults to `resolveImageInputActivation()`, the build constant that is
   *  `false` in this release. Only a test overrides it, to prove the
   *  schema-3 write path is correct ahead of activation; production wiring
   *  never sets it. */
  readonly imageInputActivation?: boolean;
}

/** The settings document schema version this release would write, given
 *  activation. Release N keeps writing schema 2 unconditionally. Nothing in
 *  production calls this with `imageInputActivation: true` yet, but the
 *  decision is threaded as one function so a later slice flips one call
 *  site, not a scattered set of schema-version literals. */
export function settingsWriteSchemaVersion(options: SettingsWriteSchemaOptions = {}): 2 | 3 {
  return resolveImageInputActivation(options.imageInputActivation) ? 3 : 2;
}
