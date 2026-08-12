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
import { parseSettingsStateV3Text } from "./settings-v3-codec.js";

/**
 * What the settings-state file actually holds. Structural sibling of
 * `StoredStorySlot` (server/story-storage-reader.ts): a discriminated union
 * of every shape the file may hold. A `"v3"` slot is
 * never mutable by this release: `settingsWriteSchemaVersion`
 * (server/settings-v3-conversion.ts) never writes schema 3, so an on-disk
 * schema-3 authority can only belong to a later release, and this release
 * must leave it exactly as it found it, forever, the same way a genuine
 * predecessor always has (`requireSettingsWriteAuthority` below is what
 * refuses it). `readOnlyView` is a schema-2-shaped projection of a
 * schema-3 state, used for every plain read. Nothing in this codebase
 * treats a bare `SettingsStateV2` value as proof that a save may proceed;
 * every mutation path calls `requireSettingsWriteAuthority` first, which
 * inspects `kind`, not a projected value, so the projection can never be
 * mistaken for something a save may write back without that check.
 */
export type SettingsStateSlot =
  | { readonly kind: "v2"; readonly state: SettingsStateV2 }
  | {
      readonly kind: "v3";
      readonly state: SettingsStateV3;
      readonly readOnlyView: SettingsStateV2;
    };

/** The read-only presentation of one settings state, transparent to schema
 *  version: a genuine schema-2 state as itself, a schema-3 state downgraded
 *  for reading. Every plain settings read goes through this. A
 *  `"v3"` slot never has a mutation working view of its
 *  own: `requireSettingsWriteAuthority` below refuses every mutation
 *  against it, so nothing ever needs one. */
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
 *  absent from a `"v3"` slot's active document, has none:
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
 *  direction. `settingsWriteSchemaVersion` (server/settings-v3-conversion.ts)
 *  keeps this release from ever writing schema 3, so no production path can
 *  create an override here yet; the day a later release adds one, a writer
 *  who marks a model `"unsupported"` and then rolls back to THIS release
 *  must still have that verdict honored on read. Dropping it would silently
 *  send an image to a model they said cannot read one. A caller that
 *  resolves image capability must pass this function's result to `resolveImageInputCapability`
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

/** What one `"v2"` slot authorizes a write to do: nothing beyond
 *  confirmation the slot is writable at all. A `"v3"`
 *  slot never earns one; see `settingsWriteAuthority` below. */
export interface SettingsWriteAuthority {
  readonly kind: "v2";
}

/** Resolve what one write against `slot` may do, or `null` to refuse it. A
 *  `"v2"` slot is always writable. A `"v3"` slot never
 *  is: this release's settings writer never produces schema 3
 *  (`settingsWriteSchemaVersion`, server/settings-v3-conversion.ts), so an
 *  on-disk schema-3 authority can only be a later release's, never this
 *  one's own prior write, and this release must leave it exactly as it
 *  found it. Non-throwing so a caller can branch on the refusal instead of
 *  using a thrown error for ordinary control flow; `requireSettingsWriteAuthority`
 *  below is the throwing wrapper for a caller that wants the refusal to
 *  propagate as an error. */
function settingsWriteAuthority(slot: SettingsStateSlot): SettingsWriteAuthority | null {
  return slot.kind === "v2" ? { kind: "v2" } : null;
}

/** Throwing wrapper over `settingsWriteAuthority`, for
 *  `SettingsV2Store`'s save/discard path, where a refusal is exactly the
 *  409 a client should see. Before the file changes, so a refusal always
 *  leaves the file byte identical.
 *
 *  `activation` is accepted only for call-site compatibility with
 *  `SettingsV2Store`, which still threads its own `imageInputActivation`
 *  option through here; it no longer changes the outcome. A schema-3 slot
 *  refuses unconditionally now that this release's writer never produces
 *  schema 3, so there is nothing left for an activation override to
 *  decide. */
export function requireSettingsWriteAuthority(
  slot: SettingsStateSlot
): SettingsWriteAuthority {
  const authority = settingsWriteAuthority(slot);
  if (authority === null) {
    throw new ServiceError(
      409,
      "Settings use a schema that only a newer release can change. Update 1667, then save again.",
      "settings_requires_successor"
    );
  }
  return authority;
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
      kind: "v3",
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
 * transitions. This is a read-only presentation: `requireSettingsWriteAuthority`
 * (above) refuses every mutation against a `"v3"` slot, so
 * this projection is never re-validated as a mutation pipeline's own working
 * view and never needs to be. It is still re-validated once per document,
 * through `parseSettingsDocumentV2` in `downgradeSettingsDocumentV3ToV2`
 * below, so a caller can trust the shape it returns.
 *
 * A downgraded active document and a downgraded candidate document CAN come
 * out byte identical: two schema-3 documents differing only by a model's
 * `imageInput`/`imageTokenCeiling` project to the same schema-2 bytes, since
 * this function drops exactly those two fields. That is expected here, for a
 * read-only view, and is why this release never treats `readOnlyView` as
 * something a save may write back (`requireSettingsWriteAuthority` refuses
 * first, unconditionally, before any code path could re-validate the
 * documents map for uniqueness).
 *
 * `activation` cannot travel unchanged: `oldHash`/`candidateHash` were bound
 * to the original schema-3 documents by the schema-3 validator
 * (`server/settings-v3-state-validation.ts`), and a projected document hashes
 * differently the moment `imageInput` is dropped.
 * `downgradeSettingsActivationV2` below rebinds both hashes to the
 * just-projected schema-2 documents. Every other field travels unchanged:
 * `lastActivationOutcome`, `lastTransaction`, and the revision numbers. None
 * of them hash a document, so none of them need rebinding.
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
 *  `downgradeSettingsStateV3ToV2` above just projected. Each schema-3
 *  document `state.activation.oldHash`/`candidateHash` bound is found by its
 *  own hash (`hashCanonicalSettingsDocument`), then the schema-2 document at
 *  that same revision key supplies the schema-2-hashed replacement. */
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
 *  A dropped capability field is never silently lost: this release refuses
 *  every mutation against a `"v3"` slot
 *  (`requireSettingsWriteAuthority` above), so nothing ever writes this
 *  projection back. `settingsStateSlotImageInputCapability` above is the
 *  separate, out-of-band channel a caller uses to still read
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
