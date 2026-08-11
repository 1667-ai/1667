import type {
  ModelCapabilitiesV3,
  ModelDefinitionV3,
  SettingsDocumentV2,
  SettingsDocumentV3,
  SettingsStateV3
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
  return advanceSettingsDocumentV3(document, new Map());
}

/** Every model ID a schema-3 state's documents carry, paired with its most
 *  recently written definition. A state holds at most two documents, the
 *  active one and a staged candidate; the active document wins a
 *  disagreement, since it is the one every reader trusts right now, and the
 *  candidate contributes only an ID the active document does not have. Used
 *  to carry `imageInput`/`imageTokenCeiling` forward across a write this
 *  release makes to its own prior schema-3 authority (`advanceSettingsDocumentV3`
 *  below); a build that has never written schema 3 for this directory has
 *  nothing to carry forward, so an absent prior state yields an empty map. */
export function priorSettingsModelsV3(state: SettingsStateV3 | null): ReadonlyMap<string, ModelDefinitionV3> {
  const byId = new Map<string, ModelDefinitionV3>();
  if (state === null) return byId;
  const activeDocument = state.documents[String(state.activeRevision)];
  const ordered = activeDocument === undefined
    ? Object.values(state.documents)
    : [activeDocument, ...Object.values(state.documents).filter((document) => document !== activeDocument)];
  for (const document of ordered) {
    for (const [id, model] of Object.entries(document.models)) {
      if (!byId.has(id)) byId.set(id, model);
    }
  }
  return byId;
}

/** Convert a schema-2 document to schema 3, the way `convertSettingsDocumentV2ToV3`
 *  does, except a model ID that named the exact same remote model
 *  (`connectionId` and `remoteId` both unchanged) in `priorModels` keeps its
 *  previously resolved `imageInput`/`imageTokenCeiling` instead of resetting
 *  to the fresh migration default. A model ID that is new, or that now names
 *  a different remote model, still gets the fresh default: the rollout plan
 *  requires exactly that reset the moment a model's identity changes, since a
 *  stale verdict for a DIFFERENT remote model would be actively wrong, not
 *  merely stale. An empty `priorModels` map (`priorSettingsModelsV3(null)`)
 *  makes every model take the fresh-default branch, which is why
 *  `convertSettingsDocumentV2ToV3` above is exactly this function called with
 *  nothing to carry forward. */
export function advanceSettingsDocumentV3(
  document: SettingsDocumentV2,
  priorModels: ReadonlyMap<string, ModelDefinitionV3>
): SettingsDocumentV3 {
  const models: Record<string, ModelDefinitionV3> = {};
  for (const [id, model] of Object.entries(document.models)) {
    const connection = document.connections[model.connectionId];
    const isDryRun = connection?.protocol === "dry-run";
    const prior = priorModels.get(id);
    const sameRemoteModel = prior !== undefined
      && prior.connectionId === model.connectionId
      && prior.remoteId === model.remoteId;
    const capabilities: ModelCapabilitiesV3 = {
      ...model.capabilities,
      imageInput: sameRemoteModel ? prior.capabilities.imageInput : (isDryRun ? "unsupported" : "unknown"),
      ...(sameRemoteModel && prior.capabilities.imageTokenCeiling !== undefined
        ? { imageTokenCeiling: prior.capabilities.imageTokenCeiling }
        : {})
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
