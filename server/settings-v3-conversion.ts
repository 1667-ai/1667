import type {
  ModelCapabilitiesV3,
  ModelDefinitionV3,
  SettingsDocumentV2,
  SettingsDocumentV3,
  SettingsProtocolV2,
  SettingsStateV2,
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

/** One prior model definition, paired with the protocol its own document
 *  resolved for it (`document.connections[model.connectionId]?.protocol`) at
 *  the time this state carried it. `advanceSettingsDocumentV3` below needs
 *  the protocol alongside `connectionId`/`remoteId` to decide whether a model
 *  kept the same identity: an Advanced-editor edit can repoint the same
 *  connection ID at a different protocol (dry-run to a live one, or back)
 *  without touching the model at all, and the fresh-derivation default this
 *  same function falls back to is itself keyed on protocol, so the
 *  carry-forward key must be too, or a model that just became image-capable
 *  keeps a stale verdict computed for the protocol it no longer uses. */
export interface PriorModelV3 {
  readonly model: ModelDefinitionV3;
  readonly protocol: SettingsProtocolV2 | undefined;
}

/** Every model ID one schema-3 document carries, paired with its definition
 *  and the protocol its own `connections` map resolves for it. */
function resolvedModelsV3(document: SettingsDocumentV3 | undefined): ReadonlyMap<string, PriorModelV3> {
  const byId = new Map<string, PriorModelV3>();
  if (document === undefined) return byId;
  for (const [id, model] of Object.entries(document.models)) {
    byId.set(id, { model, protocol: document.connections[model.connectionId]?.protocol });
  }
  return byId;
}

/** `priorState`'s carry-forward source for one revision key, for a caller
 *  about to write a replacement that must carry `imageInput`/`imageTokenCeiling`
 *  forward instead of resetting it (`advanceSettingsDocumentV3` below). A
 *  revision key `priorState` already holds is its own carry-forward source:
 *  the common case mid-activation, where staging and publishing a single save
 *  writes the same candidate revision key several times in a row
 *  (`SettingsV2Store.activateStaged`), so each later write carries forward
 *  the write immediately before it, not a stale snapshot from before the
 *  first. A revision key `priorState` does not hold yet (a candidate
 *  entering this directory's schema-3 history for the first time) falls
 *  back to `priorState`'s own active document instead, the same source a
 *  fresh migration falls back to nothing for.
 *
 *  Matching per revision key, rather than flattening every document
 *  `priorState` holds into one "active document wins" map, is what stops an
 *  outgoing active document from overwriting a candidate document that is
 *  mid-promotion: the two can carry different capabilities for the same
 *  model ID (the save that is about to activate is exactly what changed one
 *  of them), and only the candidate's own history belongs to the candidate.
 *
 *  `priorState === null` (a directory with no schema-3 authority of its own
 *  yet) yields an empty map for every revision, which is why
 *  `convertSettingsDocumentV2ToV3` above is exactly `advanceSettingsDocumentV3`
 *  called with nothing to carry forward. */
export function priorModelsForRevisionV3(
  priorState: SettingsStateV3 | null,
  revision: string
): ReadonlyMap<string, PriorModelV3> {
  if (priorState === null) return new Map();
  const ownHistory = priorState.documents[revision];
  if (ownHistory !== undefined) return resolvedModelsV3(ownHistory);
  return resolvedModelsV3(priorState.documents[String(priorState.activeRevision)]);
}

/** Convert a schema-2 document to schema 3, the way `convertSettingsDocumentV2ToV3`
 *  does, except a model ID that named the exact same remote model on the
 *  exact same protocol (`connectionId`, `remoteId`, and resolved `protocol`
 *  all unchanged) in `priorModels` keeps its previously resolved
 *  `imageInput`/`imageTokenCeiling` instead of resetting to the fresh
 *  migration default. A model ID that is new, that now names a different
 *  remote model, or whose connection now resolves a different protocol,
 *  still gets the fresh default: the rollout plan requires exactly that
 *  reset the moment a model's identity changes, since a stale verdict for a
 *  DIFFERENT remote model, or the same remote model reached through a
 *  different protocol, would be actively wrong, not merely stale. An empty
 *  `priorModels` map (`priorModelsForRevisionV3(null, ...)`) makes every
 *  model take the fresh-default branch, which is why
 *  `convertSettingsDocumentV2ToV3` above is exactly this function called with
 *  nothing to carry forward. */
export function advanceSettingsDocumentV3(
  document: SettingsDocumentV2,
  priorModels: ReadonlyMap<string, PriorModelV3>
): SettingsDocumentV3 {
  const models: Record<string, ModelDefinitionV3> = {};
  for (const [id, model] of Object.entries(document.models)) {
    const connection = document.connections[model.connectionId];
    const isDryRun = connection?.protocol === "dry-run";
    const prior = priorModels.get(id);
    const sameRemoteModel = prior !== undefined
      && prior.model.connectionId === model.connectionId
      && prior.model.remoteId === model.remoteId
      && prior.protocol === connection?.protocol;
    const capabilities: ModelCapabilitiesV3 = {
      ...model.capabilities,
      imageInput: sameRemoteModel ? prior.model.capabilities.imageInput : (isDryRun ? "unsupported" : "unknown"),
      ...(sameRemoteModel && prior.model.capabilities.imageTokenCeiling !== undefined
        ? { imageTokenCeiling: prior.model.capabilities.imageTokenCeiling }
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

/** True when writing `state` as schema 3, carrying `priorState` forward the
 *  way `advanceSettingsDocumentV3` does, would record for some model an
 *  `imageInput` or `imageTokenCeiling` value the schema-2 document itself
 *  cannot re-derive. This is the settings side's counterpart to
 *  `storyHasImageAttachments` (server/story-codec.ts): the release-wide
 *  activation switch says a write MAY use schema 3; this says the document
 *  actually NEEDS it. `settingsWriteSchemaVersion` below requires both,
 *  exactly like `encodeStoryBundle` requires its release-wide switch AND
 *  `storyHasImageAttachments`, so turning activation on never upgrades a
 *  settings document that has nothing to gain from schema 3. Every upgraded
 *  document is one a rolled-back writer might not be able to change.
 *
 *  Nothing in this codebase can make this true today: `advanceSettingsDocumentV3`
 *  only ever derives `"unsupported"` or `"unknown"`, mechanically from a
 *  connection's protocol, and `imageTokenCeiling` has no construction site
 *  anywhere in this repository (verified). A model can carry a value this
 *  predicate calls non-derivable only once a future release adds override
 *  storage, which this one does not (test/settings-schema-successor.test.ts
 *  constructs one by hand, bypassing every production code path, to prove
 *  this predicate the day that changes). Until then this always returns
 *  false, every settings save stays schema 2, and a writer who rolls back to
 *  the predecessor keeps a settings file it can still mutate. */
export function settingsStateNeedsSuccessorSchema(
  state: SettingsStateV2,
  priorState: SettingsStateV3 | null
): boolean {
  if (priorState === null) return false;
  for (const [revision, document] of Object.entries(state.documents)) {
    const priorModels = priorModelsForRevisionV3(priorState, revision);
    if (priorModels.size === 0) continue;
    for (const [id, model] of Object.entries(document.models)) {
      const prior = priorModels.get(id);
      const connection = document.connections[model.connectionId];
      const sameRemoteModel = prior !== undefined
        && prior.model.connectionId === model.connectionId
        && prior.model.remoteId === model.remoteId
        && prior.protocol === connection?.protocol;
      if (!sameRemoteModel) continue;
      const freshDefault = connection?.protocol === "dry-run" ? "unsupported" : "unknown";
      if (prior.model.capabilities.imageInput !== freshDefault) return true;
      if (prior.model.capabilities.imageTokenCeiling !== undefined) return true;
    }
  }
  return false;
}

export interface SettingsWriteSchemaOptions {
  /** Defaults to `resolveImageInputActivation()`, the build constant that is
   *  `true` in this release. Only a test overrides it, to stand in for a
   *  genuine predecessor (activation `false`) or to exercise the schema-3
   *  write path ahead of a document ever needing it; production wiring never
   *  sets it. */
  readonly imageInputActivation?: boolean;
}

/** The settings-state schema version one write should use: schema 3 only
 *  when this build resolves activation AND `needsSuccessorSchema`
 *  (`settingsStateNeedsSuccessorSchema` above, computed by the caller against
 *  this same write's own current-on-disk authority) says the document being
 *  written actually has something to gain from it. Mirrors
 *  `resolveImageInputActivation(options.activation) && storyHasImageAttachments(story)`
 *  on the story side (server/story-codec.ts): the release-wide switch alone
 *  is never enough to upgrade a document, on either side of this release. */
export function settingsWriteSchemaVersion(
  needsSuccessorSchema: boolean,
  options: SettingsWriteSchemaOptions = {}
): 2 | 3 {
  return resolveImageInputActivation(options.imageInputActivation) && needsSuccessorSchema ? 3 : 2;
}
