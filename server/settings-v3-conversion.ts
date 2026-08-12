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
 *  No production code path calls this: `settingsWriteSchemaVersion` below
 *  never writes schema 3, so nothing in this build ever needs to produce
 *  one outside a test fixture standing in for a later release's write
 *  (test/settings-schema-successor.test.ts). An earlier version of this
 *  function also carried a prior schema-3 document's `imageInput`/
 *  `imageTokenCeiling` forward across a save, so a value a capability
 *  resolver or an explicit override had already recorded would survive the
 *  next migration instead of resetting. That carry-forward machinery is
 *  gone: this release never has a prior schema-3 authority of its own to
 *  carry forward from, because it never writes one. The release that adds
 *  override storage is the one that must rebuild carry-forward, against the
 *  incoming value it will actually have in hand. */
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
    writing: document.writing
  });
}

export interface SettingsWriteSchemaOptions {
  /** No longer changes the outcome: `settingsWriteSchemaVersion` below
   *  always returns 2. Kept only for call-site compatibility with
   *  `SettingsV2Store` and `stageSettingsState` (server/settings-state-file.ts),
   *  which still thread an `imageInputActivation` option through to here. */
  readonly imageInputActivation?: boolean;
}

/** The settings-state schema version every write uses: always 2.
 *
 * This release activates the successor STORY schema but not the successor
 * SETTINGS schema. The gate that would enable a settings-schema-3 write can
 * only read a value from the schema-3 file already on disk, and that file
 * can only exist if the gate already fired: a closed loop no build could
 * ever satisfy honestly. Nor can this release repair that in place.
 * `ModelCapabilitiesV2`, the shape every incoming write arrives as, is a
 * closed record with no `imageInput` field, so a capability override cannot
 * structurally arrive in an incoming schema-2 write for this build to act
 * on. Only the release that adds override storage ever holds the incoming
 * value, so only that release can honestly decide whether a given write
 * needs schema 3. The successor settings WRITER ships with that release,
 * not this one; this release keeps only the schema-3 reader and the
 * downgrade projection, so a writer who rolls back from that later release
 * can still open what it wrote. */
export function settingsWriteSchemaVersion(): 2 {
  return 2;
}
