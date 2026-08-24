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
import type { SettingsStateV4 } from "../shared/settings-v4-types.js";
import type { SettingsStateV5 } from "../shared/settings-v5-types.js";
import { MAX_SETTINGS_STATE_V5_BYTES } from "../shared/settings-v5-limits.js";
import { canonicalJson } from "./canonical-json.js";
import { ServiceError } from "./errors.js";
import { hashSettingsDocumentV2, parseSettingsDocumentV2, parseSettingsStateV2 } from "./settings-v2-codec.js";
import { hashCanonicalSettingsDocument } from "./settings-v2-hash.js";
import { SettingsFormatError } from "./settings-v2-scalars.js";
import { parseSettingsStateV3 } from "./settings-v3-codec.js";
import { parseSettingsStateV4 } from "./settings-v4-codec.js";
import { parseSettingsStateV5 } from "./settings-v5-codec.js";
import {
  effectiveSettingsStateRevision,
  settingsStateRelation,
  type SettingsStateRelation
} from "./settings-state-validation.js";
import { SETTINGS_SAVE_ADMISSIBLE_RELATIONS } from "./settings-state-reducer.js";
import { parseJsonRejectingDuplicateKeys } from "./strict-json.js";
import { decodeSettingsBytes } from "./settings-codec-shared.js";

/** What the settings-state file actually holds. `readOnlyView` is a
 * schema-2-shaped projection used only by plain readers of schema 3. */
export type SettingsStateSlot =
  | { readonly kind: "v2"; readonly state: SettingsStateV2 }
  | {
      readonly kind: "v3";
      readonly state: SettingsStateV3;
      readonly readOnlyView: SettingsStateV2;
    }
  /** Keep schema 4's full document for a faithful runtime reader. Clean and
   *  staged schema-4 states can upgrade on their first save. */
  | { readonly kind: "v4"; readonly state: SettingsStateV4 }
  | { readonly kind: "v5"; readonly state: SettingsStateV5 };

/** The read-only presentation of one settings state. Plain readers use this
 * projection for schema 3 and keep schema 4/5 in their typed runtime path. */
export function settingsStateSlotReadOnlyView(slot: SettingsStateSlot): SettingsStateV2 {
  if (slot.kind === "v2") return slot.state;
  if (slot.kind === "v3") return slot.readOnlyView;
  throw new ServiceError(
    409,
    "Settings use a schema that only a newer release can change. Read the schema-4 or schema-5 route through its typed runtime view.",
    "settings_requires_successor"
  );
}

/** Return a successor-owned schema-4 state without dropping its new controls. */
export function settingsStateSlotV4ReadOnlyView(slot: SettingsStateSlot): SettingsStateV4 | null {
  return slot.kind === "v4" ? slot.state : null;
}

/** One model's stored image-input data: schema 3's `imageInput`, an explicit
 *  writer verdict, and its optional `imageTokenCeiling`. */
export interface StoredImageInputCapability {
  readonly imageInput: FeatureSupportV2;
  readonly imageTokenCeiling?: number;
}

/** `slot`'s stored image-input data for one model ID, read straight from its
 *  effective schema-3 or schema-4 document when it has one. A `"v2"` slot, or
 *  a model ID absent from the effective successor document, has none:
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
 *  Promoted states use the same effective revision as runtime readers, so
 *  image authorization cannot pair an old runtime with a candidate verdict.
 *
 *  This is the read half of the rollback guarantee running in the other
 *  direction. This release's settings writer never produces schema 3 at
 *  all, so no production path can create an override here yet; the day a
 *  later release adds one, a writer
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
  const effective = slot.state.documents[String(effectiveSettingsStateRevision(slot.state))];
  const model = effective?.models[modelId];
  if (model === undefined) return null;
  return {
    imageInput: model.capabilities.imageInput,
    imageTokenCeiling: model.capabilities.imageTokenCeiling
  };
}

/** Admit a settings write only at a stable activation boundary.
 *
 * Source schemas 3 and 4 are writable during their first save, but only after
 * the caller recovers any in-progress activation. This check is the single
 * write-admission policy for every schema. Plain reads do not call it, so
 * startup can remain read-only for successor-owned files. */
export function requireSettingsStateSlotWriteAdmission(
  slot: SettingsStateSlot
): void {
  const relation = settingsStateSlotRelation(slot);
  if (SETTINGS_SAVE_ADMISSIBLE_RELATIONS.includes(relation)) return;
  if (slot.kind === "v3" || slot.kind === "v4") {
    throw new ServiceError(
      409,
      "Settings use a schema that only a newer release can change while activation is incomplete.",
      "settings_requires_successor"
    );
  }
  throw new ServiceError(
    409,
    "Settings activation is incomplete; retry after restarting the backend.",
    "conflict"
  );
}

function settingsStateSlotRelation(slot: SettingsStateSlot): SettingsStateRelation {
  switch (slot.kind) {
    case "v2": return settingsStateRelation(slot.state);
    case "v3": return settingsStateRelation(slot.state);
    case "v4": return settingsStateRelation(slot.state);
    case "v5": return settingsStateRelation(slot.state);
  }
}

/**
 * Parse one settings-state file's bytes as either schema. A writer who moves
 * back one release still opens their settings this way: schema 2 parses as
 * itself, and schema 3 parses and downgrades to a read-only view.
 *
 * The top-level schema version selects exactly one validator. An unknown or
 * missing version keeps the schema-2 diagnostic, since schema 2 is the shape
 * this release expects by default. The JSON is decoded and parsed once before
 * this dispatch, so an invalid successor state reports its own validator
 * diagnostic instead of a schema-2 failure after multiple full parses.
 */
export function parseSettingsStateSlotBytes(bytes: Uint8Array): SettingsStateSlot {
  if (bytes.byteLength > MAX_SETTINGS_STATE_V5_BYTES) {
    throw new SettingsFormatError(`Settings state exceeds its ${MAX_SETTINGS_STATE_V5_BYTES}-byte size limit`);
  }
  const text = decodeSettingsBytes(bytes, "settings state");
  const value = parseJsonRejectingDuplicateKeys(text, "settings state");
  let slot: SettingsStateSlot;
  switch (settingsStateSchemaVersion(value)) {
    case 2:
      slot = { kind: "v2", state: parseSettingsStateV2(value) };
      break;
    case 3: {
      const state = parseSettingsStateV3(value);
      slot = {
        kind: "v3",
        state,
        readOnlyView: downgradeSettingsStateV3ToV2(state)
      };
      break;
    }
    case 4:
      slot = { kind: "v4", state: parseSettingsStateV4(value) };
      break;
    case 5:
      slot = { kind: "v5", state: parseSettingsStateV5(value) };
      break;
    default:
      // Preserve the predecessor's default diagnostic for a missing or
      // unsupported top-level version.
      slot = { kind: "v2", state: parseSettingsStateV2(value) };
      break;
  }
  if (canonicalJson(value) !== text) {
    throw new SettingsFormatError("Settings state is not canonical JSON");
  }
  return slot;
}

function settingsStateSchemaVersion(value: unknown): 2 | 3 | 4 | 5 | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const schemaVersion = (value as { readonly schemaVersion?: unknown }).schemaVersion;
  return schemaVersion === 2 || schemaVersion === 3 || schemaVersion === 4 || schemaVersion === 5
    ? schemaVersion
    : null;
}

/**
 * Downgrade a whole schema-3 state to a schema-2 view. Every document in the
 * state's revision table is projected, there are at most two, the active
 * document and a pending candidate mid-activation, so a reader sees a
 * consistent picture regardless of the successor's own in-progress
 * transitions. This is a read-only presentation. The write admission helper
 * runs on the full slot before conversion, so this projection is never used
 * as a mutation working view. It is still re-validated once per document,
 * through `parseSettingsDocumentV2` in `downgradeSettingsDocumentV3ToV2`
 * below, so a caller can trust the shape it returns.
 *
 * A downgraded active document and a downgraded candidate document CAN come
 * out byte identical: two schema-3 documents differing only by a model's
 * `imageInput`/`imageTokenCeiling` project to the same schema-2 bytes, since
 * this function drops exactly those two fields. That is expected here, for a
 * read-only view. A save never writes this projection back.
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
 *  A dropped capability field is never silently lost: the write admission
 *  helper runs against the full successor slot, so nothing ever writes this
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
