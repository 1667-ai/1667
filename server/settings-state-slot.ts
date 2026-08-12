import type {
  FeatureSupportV2,
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
import { advanceSettingsDocumentV3, priorModelsForRevisionV3 } from "./settings-v3-conversion.js";
import { resolveImageInputActivation } from "../shared/image-input-release.js";

/**
 * What the settings-state file actually holds. Structural sibling of
 * `StoredStorySlot` (server/story-storage-reader.ts): a discriminated union
 * of every shape the file may hold. Whether a `"v3-requires-successor"` slot
 * is actually mutable is not decided here, at parse time, but in
 * `requireSettingsWriteAuthority` below: a release that resolves activation
 * true owns writing schema 3 and keeps mutating its own prior schema-3
 * authority exactly like schema 2, the same rule the story side's V8
 * envelope follows (`shared/image-input-release.ts`); a release that
 * resolves activation false refuses every mutation against it, forever.
 * `readOnlyView` is a schema-2-shaped projection of a schema-3 state, used
 * both for plain reads and as the mutation pipeline's own working view when
 * activation makes the slot mutable. Nothing in this codebase treats a bare
 * `SettingsStateV2` value as proof that a save may proceed; every mutation
 * path calls `requireSettingsWriteAuthority` first, which inspects `kind`
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

/** The read-only presentation of one settings state, transparent to schema
 *  version: a genuine schema-2 state as itself, a schema-3 state downgraded
 *  for reading. Every plain settings read goes through this, and so does the
 *  mutation pipeline's own working view of a schema-3 slot activation makes
 *  mutable. The pipeline stays schema-2-typed throughout; only the write
 *  boundary (`upgradeSettingsStateV2ToV3`) re-encodes schema 3. */
export function settingsStateSlotReadOnlyView(slot: SettingsStateSlot): SettingsStateV2 {
  return slot.kind === "v2" ? slot.state : slot.readOnlyView;
}

/** One model's stored image-input data: schema 3's `imageInput`, an explicit
 *  writer verdict, and its optional `imageTokenCeiling`. */
export interface StoredImageInputCapability {
  readonly imageInput: FeatureSupportV2;
  readonly imageTokenCeiling?: number;
}

/** `slot`'s stored image-input data for one model ID, read straight from its
 *  schema-3 active document when it has one. A `"v2"` slot, or a model ID
 *  absent from a `"v3-requires-successor"` slot's active document, has none:
 *  schema 2 cannot carry the field at all, and `resolveImageInputCapability`
 *  (shared/image-input-capabilities.ts) already treats a missing override the
 *  same as an absent one.
 *
 *  Deliberately NOT part of `settingsStateSlotReadOnlyView`'s schema-2-shaped
 *  projection above: that view is re-validated against the closed schema-2
 *  JSON Schema, and a schema-2 write re-serializes it byte for byte, so
 *  embedding `imageInput`/`imageTokenCeiling` there would either be rejected
 *  by that validation or leak into schema-2 bytes, exactly the outcome
 *  `downgradeModelCapabilitiesV3ToV2` below exists to prevent. This function
 *  is the separate, out-of-band channel a caller uses instead.
 *
 *  This is the read half of the rollback guarantee running in the other
 *  direction. `settingsStateNeedsSuccessorSchema` (server/settings-v3-conversion.ts)
 *  keeps this release from writing an override no production path can create
 *  yet; the day a later release adds one, a writer who marks a model
 *  `"unsupported"` and then rolls back to THIS release must still have that
 *  verdict honored on read. Dropping it would silently send an image to a
 *  model they said cannot read one. A caller that resolves image
 *  capability must pass this function's result to `resolveImageInputCapability`
 *  as `ImageInputContext.override`/`overrideTokenCeiling`, the explicit
 *  override its documented resolution order already expects, ahead of exact
 *  built-in model knowledge. */
export function settingsStateSlotImageInputCapability(
  slot: SettingsStateSlot,
  modelId: string
): StoredImageInputCapability | null {
  if (slot.kind === "v2") return null;
  const active = slot.state.documents[String(slot.state.activeRevision)];
  const model = active?.models[modelId];
  if (model === undefined) return null;
  return {
    imageInput: model.capabilities.imageInput,
    imageTokenCeiling: model.capabilities.imageTokenCeiling
  };
}

/** What one slot authorizes a write to do: a `"v2"` slot has no schema-3
 *  authority of its own to carry forward; a `"v3-owned"` slot is this
 *  build's own prior schema-3 authority (`priorModelsForRevisionV3`,
 *  server/settings-v3-conversion.ts, is what a write carries it forward
 *  through). This is the only way to obtain `prior`: permission and the
 *  carry-forward source are one call, so a caller can never hold one without
 *  having already earned it, unlike a bare `SettingsStateV3 | null` a
 *  caller could extract from a slot without checking `kind` or activation
 *  first. */
export type SettingsWriteAuthority =
  | { readonly kind: "v2" }
  | { readonly kind: "v3-owned"; readonly prior: SettingsStateV3 };

/** Resolve what one write against `slot` may do, or refuse it. A `"v2"` slot
 *  is always writable. A `"v3-requires-successor"` slot is writable only when
 *  this build resolves activation true, in which case this release owns
 *  writing schema 3 and keeps mutating its own prior authority. Otherwise
 *  this throws, before the file changes, so the file stays byte identical.
 *  `activation` defaults through `resolveImageInputActivation()`, the same
 *  release-wide switch every other image-input gate reads; a caller
 *  overrides it only to prove the predecessor's permanent refusal in a test.
 *
 *  Both `SettingsV2Store.init()` and `SettingsV2Store`'s save/discard path
 *  call this same function: `init()` catches the refusal to start up
 *  read-only instead of propagating it, because a schema-3 authority this
 *  build cannot write is successor-owned at startup, not a request error;
 *  a save or discard lets it propagate as the 409 a client sees. */
export function requireSettingsWriteAuthority(
  slot: SettingsStateSlot,
  activation?: boolean
): SettingsWriteAuthority {
  if (slot.kind === "v2") return { kind: "v2" };
  if (!resolveImageInputActivation(activation)) {
    throw new ServiceError(
      409,
      "Settings use a schema that only a newer release can change. Update 1667, then save again.",
      "settings_requires_successor"
    );
  }
  return { kind: "v3-owned", prior: slot.state };
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
      readOnlyView: downgradeSettingsStateV3ToV2(successor)
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
function downgradeSettingsStateV3ToV2(state: SettingsStateV3): SettingsStateV2 {
  const documents: Record<string, SettingsDocumentV2> = {};
  for (const [revision, document] of Object.entries(state.documents)) {
    documents[revision] = downgradeSettingsDocumentV3ToV2(document);
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
 *  `downgradeSettingsStateV3ToV2` above just projected. This mirrors
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
 *  the projection is a genuine schema-2 document and freezes it.
 *
 *  This projection is not a display-only read anymore: it is also the
 *  mutation pipeline's own working view of a schema-3 slot activation makes
 *  mutable (`SettingsStateSlot`'s doc comment above), so a schema-3-only
 *  capability field this function forgets to drop would silently ride along
 *  on the writer's next save. `settingsStateSlotImageInputCapability` above
 *  is the separate, out-of-band channel a caller uses to still read
 *  `imageInput`/`imageTokenCeiling` without embedding them here. */
function downgradeSettingsDocumentV3ToV2(document: SettingsDocumentV3): SettingsDocumentV2 {
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

/** Every schema-2 capability field, derived by omitting exactly the two
 *  schema-3-only keys rather than hand-listing schema 2's fields one at a
 *  time: a future OPTIONAL schema-2 capability field this file does not yet
 *  know about round-trips automatically instead of being silently dropped
 *  the way a hand-listed set would drop it (`reasoningContent` was already a
 *  near miss here once). `Omit<ModelCapabilitiesV3, ...>` is structurally
 *  `ModelCapabilitiesV2`, because schema 3 adds exactly those two fields and
 *  nothing else. */
function downgradeModelCapabilitiesV3ToV2(capabilities: ModelCapabilitiesV3): ModelCapabilitiesV2 {
  const { imageInput: _imageInput, imageTokenCeiling: _imageTokenCeiling, ...capabilitiesV2 } = capabilities;
  return capabilitiesV2;
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
 * directory, when one exists (`requireSettingsWriteAuthority` below, absent
 * for a directory's first-ever schema-3 write). Passing it through
 * `priorModelsForRevisionV3`/`advanceSettingsDocumentV3` (server/settings-v3-conversion.ts),
 * matched to `state.documents` one revision key at a time rather than
 * flattened into one map, is what keeps a model's `imageInput`/`imageTokenCeiling`
 * from resetting on every later save without letting an outgoing active
 * document overwrite a candidate document that is mid-promotion: without it,
 * this function would re-derive the fresh migration default for every model
 * on every write, discarding whatever a capability resolver or an explicit
 * override had already recorded.
 */
export function upgradeSettingsStateV2ToV3(
  state: SettingsStateV2,
  priorState: SettingsStateV3 | null = null
): SettingsStateV3 {
  const documents: Record<string, SettingsDocumentV3> = {};
  for (const [revision, document] of Object.entries(state.documents)) {
    documents[revision] = advanceSettingsDocumentV3(
      document,
      priorModelsForRevisionV3(priorState, revision)
    );
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
