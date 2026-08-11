import type {
  ModelCapabilitiesV2,
  ModelCapabilitiesV3,
  ModelDefinitionV2,
  ModelDefinitionV3,
  SettingsActivationV2,
  SettingsDocumentV2,
  SettingsDocumentV3,
  SettingsStateV2,
  SettingsStateV3
} from "../shared/settings-v2-types.js";
import { decodeCanonicalUtf8 } from "./canonical-json.js";
import { ServiceError } from "./errors.js";
import { hashSettingsDocumentV2, parseSettingsDocumentV2, parseSettingsStateV2Bytes } from "./settings-v2-codec.js";
import { hashCanonicalSettingsDocument } from "./settings-v2-hash.js";
import { MAX_SETTINGS_STATE_BYTES, SettingsFormatError } from "./settings-v2-scalars.js";
import { parseSettingsStateV3, parseSettingsStateV3Text } from "./settings-v3-codec.js";
import { advanceSettingsDocumentV3, priorSettingsModelsV3 } from "./settings-v3-conversion.js";
import { resolveImageInputActivation } from "../shared/image-input-release.js";

/**
 * What the settings-state file actually holds. Structural sibling of
 * `StoredStorySlot` (server/story-storage-reader.ts): a discriminated union
 * of every shape the file may hold, with `MutableSettingsStateSlot` naming
 * the subset a write may act on.
 *
 * Schema 3 is the settings successor (server/settings-v3-codec.ts). Every
 * release reads and validates it. Whether a `"v3-requires-successor"` slot
 * is actually mutable is not decided here, at parse time, but in
 * `requireMutableSettingsStateSlot` below: a release that resolves
 * activation true owns writing schema 3 and keeps mutating its own prior
 * schema-3 authority exactly like schema 2, the same rule the story side's
 * V8 envelope follows (`shared/image-input-release.ts`); a release that
 * resolves activation false refuses every mutation against it, forever.
 * `readOnlyView` is a schema-2-shaped projection of a schema-3 state, used
 * both for plain reads and as the mutation pipeline's own working view when
 * activation makes the slot mutable. Nothing in this codebase treats a bare
 * `SettingsStateV2` value as proof that a save may proceed; every mutation
 * path calls `requireMutableSettingsStateSlot` first, which inspects `kind`
 * and activation, not a projected value, so the projection can never be
 * mistaken for something a save may write back without that check.
 */
export type SettingsStateSlot =
  | { readonly kind: "v2"; readonly state: SettingsStateV2 }
  | {
      readonly kind: "v3-requires-successor";
      readonly state: SettingsStateV3;
      readonly readOnlyView: SettingsStateV2;
    };

export type MutableSettingsStateSlot = Extract<SettingsStateSlot, { kind: "v2" }>;

/** The read-only presentation of one settings state, transparent to schema
 *  version: a genuine schema-2 state as itself, a schema-3 state downgraded
 *  for reading. Every plain settings read goes through this, and so does the
 *  mutation pipeline's own working view of a schema-3 slot activation makes
 *  mutable. The pipeline stays schema-2-typed throughout; only the write
 *  boundary (`upgradeSettingsStateV2ToV3`) re-encodes schema 3. */
export function settingsStateSlotReadOnlyView(slot: SettingsStateSlot): SettingsStateV2 {
  return slot.kind === "v2" ? slot.state : slot.readOnlyView;
}

/** The schema-3 authority a `"v3-requires-successor"` slot carries, for a
 *  caller about to write a replacement that must carry its
 *  `imageInput`/`imageTokenCeiling` data forward (`priorSettingsModelsV3`,
 *  server/settings-v3-conversion.ts). A `"v2"` slot has no schema-3
 *  authority of its own to carry forward. Callers that reach this after
 *  `requireMutableSettingsStateSlot` already resolved activation true own
 *  writing whatever this returns; a caller that has not made that check yet
 *  must not treat a non-null result as permission to write. */
export function settingsStateSlotPriorV3(slot: SettingsStateSlot): SettingsStateV3 | null {
  return slot.kind === "v3-requires-successor" ? slot.state : null;
}

/** Refuse a mutation against a schema-3 settings state, unless this build
 *  resolves activation true, in which case this release owns writing schema
 *  3 and keeps mutating its own prior authority. Call this before any write
 *  so a genuine refusal happens before the file changes, and the file stays
 *  byte identical. `activation` defaults through `resolveImageInputActivation()`,
 *  the same release-wide switch every other image-input gate reads; a caller
 *  overrides it only to prove the predecessor's permanent refusal in a test. */
export function requireMutableSettingsStateSlot(
  slot: SettingsStateSlot,
  activation?: boolean
): void {
  if (slot.kind === "v3-requires-successor" && !resolveImageInputActivation(activation)) {
    throw new ServiceError(
      409,
      "Settings use a schema that only a newer release can change. Update 1667, then save again.",
      "settings_requires_successor"
    );
  }
}

/**
 * Parse one settings-state file's bytes as either schema. A writer who moves
 * back one release still opens their settings this way: schema 2 parses as
 * itself, and schema 3 parses and downgrades to a read-only view.
 *
 * A schema-2 parse runs first because it is what this release's own writer
 * always produces. When it fails, a schema-3 attempt follows; if that also
 * fails, the original schema-2 error is the one reported, since schema 2 is
 * the shape this release expects by default.
 */
export function parseSettingsStateSlotBytes(bytes: Uint8Array): SettingsStateSlot {
  try {
    return { kind: "v2", state: parseSettingsStateV2Bytes(bytes) };
  } catch (v2Error) {
    let successor: SettingsStateV3;
    try {
      successor = parseSettingsStateV3FromBytes(bytes);
    } catch {
      throw v2Error;
    }
    return {
      kind: "v3-requires-successor",
      state: successor,
      readOnlyView: downgradeSettingsStateV3ToV2ReadOnly(successor)
    };
  }
}

function parseSettingsStateV3FromBytes(bytes: Uint8Array): SettingsStateV3 {
  if (bytes.byteLength > MAX_SETTINGS_STATE_BYTES) {
    throw new SettingsFormatError(`Settings state exceeds its ${MAX_SETTINGS_STATE_BYTES}-byte size limit`);
  }
  let text: string;
  try {
    text = decodeCanonicalUtf8(bytes, "settings state");
  } catch (error) {
    throw new SettingsFormatError("settings state is not strict UTF-8", { cause: error });
  }
  return parseSettingsStateV3Text(text);
}

/**
 * Downgrade a whole schema-3 state to a schema-2 view. Every document in the
 * state's revision table is projected, there are at most two, the active
 * document and a pending candidate mid-activation, so a reader sees a
 * consistent picture regardless of the successor's own in-progress
 * transitions. This same projection is also the mutation pipeline's own
 * working view of a schema-3 slot activation makes mutable
 * (`SettingsStateSlot`'s doc comment above), and that pipeline does
 * re-validate it as schema 2 on every recovery pass
 * (`recoveryEventForSettingsStateV2`, server/settings-v2-reducer.ts), so this
 * function builds a state that genuinely passes that check rather than one
 * that merely looks like it does.
 *
 * `activation` cannot travel unchanged: `oldHash`/`candidateHash` were bound
 * to the original schema-3 documents (by the reducer for schema 2, or by
 * `advanceSettingsActivationV3` above for a schema-3 write this same release
 * made), and a projected document hashes differently the moment
 * `imageInput` is dropped. `downgradeSettingsActivationV2` below rebinds
 * both hashes to the just-projected schema-2 documents, the same way
 * `advanceSettingsActivationV3` rebinds the other direction. Every other
 * field travels unchanged: `lastActivationOutcome`, `lastTransaction`, and
 * the revision numbers. None of them hash a document, so none of them need
 * rebinding.
 */
function downgradeSettingsStateV3ToV2ReadOnly(state: SettingsStateV3): SettingsStateV2 {
  const documents: Record<string, SettingsDocumentV2> = {};
  for (const [revision, document] of Object.entries(state.documents)) {
    documents[revision] = downgradeSettingsDocumentV3ToV2ReadOnly(document);
  }
  return Object.freeze({
    schemaVersion: 2,
    stateGeneration: state.stateGeneration,
    settingsRevisionClock: state.settingsRevisionClock,
    documents: Object.freeze(documents),
    activeRevision: state.activeRevision,
    pendingRevision: state.pendingRevision,
    previousRevision: state.previousRevision,
    activation: downgradeSettingsActivationV2(state, documents),
    lastActivationOutcome: state.lastActivationOutcome,
    lastTransaction: state.lastTransaction
  });
}

/** Rebind `state.activation`'s hashes to the schema-2 documents
 *  `downgradeSettingsStateV3ToV2ReadOnly` above just projected. This mirrors
 *  `advanceSettingsActivationV3`'s upgrade-direction rebind. Each
 *  schema-3 document `state.activation.oldHash`/`candidateHash` bound is
 *  found by its own hash (`hashCanonicalSettingsDocument`), then the
 *  schema-2 document at that same revision key supplies the schema-2-hashed
 *  replacement. */
function downgradeSettingsActivationV2(
  state: SettingsStateV3,
  documentsV2: Readonly<Record<string, SettingsDocumentV2>>
): SettingsActivationV2 | null {
  if (state.activation === null) return null;
  const activation = state.activation;
  return {
    ...activation,
    oldHash: hashSettingsDocumentV2(
      documentAtHashV3(state, documentsV2, activation.oldHash, "oldHash")
    ),
    candidateHash: hashSettingsDocumentV2(
      documentAtHashV3(state, documentsV2, activation.candidateHash, "candidateHash")
    )
  };
}

function documentAtHashV3(
  state: SettingsStateV3,
  documentsV2: Readonly<Record<string, SettingsDocumentV2>>,
  hash: string,
  field: "oldHash" | "candidateHash"
): SettingsDocumentV2 {
  const revision = Object.entries(state.documents).find(
    ([, document]) => hashCanonicalSettingsDocument(document) === hash
  )?.[0];
  if (revision === undefined) {
    throw new SettingsFormatError(`settings activation ${field} does not bind any document in this state`);
  }
  return documentsV2[revision]!;
}

/** Downgrade one schema-3 document: drop `imageInput` and `imageTokenCeiling`
 *  from every model's capabilities. Every other field is identical between
 *  the two schemas. Re-validating through `parseSettingsDocumentV2` proves
 *  the projection is a genuine schema-2 document and freezes it. */
function downgradeSettingsDocumentV3ToV2ReadOnly(document: SettingsDocumentV3): SettingsDocumentV2 {
  const models: Record<string, ModelDefinitionV2> = {};
  for (const [id, model] of Object.entries(document.models)) {
    models[id] = downgradeModelDefinitionV3ToV2(model);
  }
  return parseSettingsDocumentV2({
    schemaVersion: 2,
    connections: document.connections,
    models,
    profiles: document.profiles,
    routing: document.routing,
    writing: document.writing
  });
}

function downgradeModelDefinitionV3ToV2(model: ModelDefinitionV3): ModelDefinitionV2 {
  return {
    connectionId: model.connectionId,
    remoteId: model.remoteId,
    name: model.name,
    discovered: model.discovered,
    overrides: model.overrides,
    capabilities: downgradeModelCapabilitiesV3ToV2(model.capabilities)
  };
}

function downgradeModelCapabilitiesV3ToV2(capabilities: ModelCapabilitiesV3): ModelCapabilitiesV2 {
  const { temperature, assistantPrefill, reasoningEffort, promptCaching, reasoningContent } = capabilities;
  return reasoningContent === undefined
    ? { temperature, assistantPrefill, reasoningEffort, promptCaching }
    : { temperature, assistantPrefill, reasoningEffort, promptCaching, reasoningContent };
}

/**
 * Upgrade a schema-2 state to schema 3, for the one write site
 * (`server/settings-state-file.ts`'s `stageSettingsState`) that reaches this
 * when `settingsWriteSchemaVersion` resolves to 3.
 *
 * `state.activation`'s hashes cannot travel unchanged: `oldHash`/`candidateHash`
 * are computed by the schema-2-typed reducer (`server/settings-v2-reducer.ts`)
 * against the schema-2 documents this function is about to convert, but
 * `validateActivationBinding` (server/settings-state-validation.ts) rehashes
 * whichever schema it is validating. A schema-3 document hashes differently
 * from its schema-2 source the moment `imageInput` is added, so a copied
 * schema-2 hash would never bind its schema-3 document, even though nothing
 * is actually wrong. `advanceSettingsActivationV3` below rebinds both hashes
 * to the just-converted schema-3 documents, keyed by which schema-2
 * documents they originally bound, so a non-null `activation` upgrades
 * exactly as soundly as a null one.
 *
 * `priorState` is this release's own prior schema-3 authority for this same
 * directory, when one exists (`settingsStateSlotPriorV3`, absent for a
 * directory's first-ever schema-3 write). Passing it through
 * `priorSettingsModelsV3`/`advanceSettingsDocumentV3` (server/settings-v3-conversion.ts)
 * is what keeps a model's `imageInput`/`imageTokenCeiling` from resetting on
 * every later save: without it, this function would re-derive the fresh
 * migration default for every model on every write, discarding whatever a
 * capability resolver or an explicit override had already recorded.
 */
export function upgradeSettingsStateV2ToV3(
  state: SettingsStateV2,
  priorState: SettingsStateV3 | null = null
): SettingsStateV3 {
  const priorModels = priorSettingsModelsV3(priorState);
  const documents: Record<string, SettingsDocumentV3> = {};
  for (const [revision, document] of Object.entries(state.documents)) {
    documents[revision] = advanceSettingsDocumentV3(document, priorModels);
  }
  return parseSettingsStateV3({
    schemaVersion: 3,
    stateGeneration: state.stateGeneration,
    settingsRevisionClock: state.settingsRevisionClock,
    documents,
    activeRevision: state.activeRevision,
    pendingRevision: state.pendingRevision,
    previousRevision: state.previousRevision,
    activation: advanceSettingsActivationV3(state, documents),
    lastActivationOutcome: state.lastActivationOutcome,
    lastTransaction: state.lastTransaction
  });
}

/** Rebind `state.activation`'s hashes to the schema-3 documents
 *  `upgradeSettingsStateV2ToV3` above just converted. Each schema-2 document
 *  `state.activation.oldHash`/`candidateHash` bound is found by its own hash
 *  (`hashSettingsDocumentV2`, the same function the reducer used to bind it
 *  in the first place), then the schema-3 document at that same revision key
 *  supplies the schema-3-hashed replacement. Absent `activation` needs no
 *  rebinding. */
function advanceSettingsActivationV3(
  state: SettingsStateV2,
  documentsV3: Readonly<Record<string, SettingsDocumentV3>>
): SettingsActivationV2 | null {
  if (state.activation === null) return null;
  const activation = state.activation;
  return {
    ...activation,
    oldHash: hashCanonicalSettingsDocument(documentAtHash(state, documentsV3, activation.oldHash, "oldHash")),
    candidateHash: hashCanonicalSettingsDocument(
      documentAtHash(state, documentsV3, activation.candidateHash, "candidateHash")
    )
  };
}

function documentAtHash(
  state: SettingsStateV2,
  documentsV3: Readonly<Record<string, SettingsDocumentV3>>,
  hash: string,
  field: "oldHash" | "candidateHash"
): SettingsDocumentV3 {
  const revision = Object.entries(state.documents).find(
    ([, document]) => hashSettingsDocumentV2(document) === hash
  )?.[0];
  if (revision === undefined) {
    throw new SettingsFormatError(`settings activation ${field} does not bind any document in this state`);
  }
  return documentsV3[revision]!;
}
