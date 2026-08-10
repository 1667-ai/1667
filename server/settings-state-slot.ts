import type {
  ModelCapabilitiesV2,
  ModelCapabilitiesV3,
  ModelDefinitionV2,
  ModelDefinitionV3,
  SettingsDocumentV2,
  SettingsDocumentV3,
  SettingsStateV2,
  SettingsStateV3
} from "../shared/settings-v2-types.js";
import { decodeCanonicalUtf8 } from "./canonical-json.js";
import { ServiceError } from "./errors.js";
import { parseSettingsDocumentV2, parseSettingsStateV2Bytes } from "./settings-v2-codec.js";
import { MAX_SETTINGS_STATE_BYTES, SettingsFormatError } from "./settings-v2-scalars.js";
import { parseSettingsStateV3, parseSettingsStateV3Text } from "./settings-v3-codec.js";
import { convertSettingsDocumentV2ToV3 } from "./settings-v3-conversion.js";

/**
 * What the settings-state file actually holds. Structural sibling of
 * `StoredStorySlot` (server/story-storage-reader.ts): a discriminated union
 * of every shape the file may hold, with `MutableSettingsStateSlot` naming
 * the subset a write may act on.
 *
 * Schema 3 is the settings successor (server/settings-v3-codec.ts). This
 * release reads and validates it and keeps its own writer on schema 2
 * (`server/settings-v3-conversion.ts`, `shared/image-input-release.ts`), so
 * it never produces one. `readOnlyView` is a schema-2-shaped projection of
 * a schema-3 state for code that only reads settings. Nothing in this
 * codebase treats a bare `SettingsStateV2` value as proof that a save may
 * proceed; every mutation path calls `requireMutableSettingsStateSlot`
 * first, which inspects `kind`, not a projected value, so the projection
 * can never be mistaken for something a save may write back.
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
 *  for reading. Every plain settings read goes through this. */
export function settingsStateSlotReadOnlyView(slot: SettingsStateSlot): SettingsStateV2 {
  return slot.kind === "v2" ? slot.state : slot.readOnlyView;
}

/** Refuse a mutation against a schema-3 settings state. Call this before any
 *  write so the refusal happens before the file changes, and the file stays
 *  byte identical. */
export function requireMutableSettingsStateSlot(
  slot: SettingsStateSlot
): asserts slot is MutableSettingsStateSlot {
  if (slot.kind === "v3-requires-successor") {
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
 * Downgrade a whole schema-3 state to a read-only schema-2 view. Every
 * document in the state's revision table is projected, there are at most
 * two, the active document and a pending candidate mid-activation, so a
 * read-only caller sees a consistent picture regardless of the successor's
 * own in-progress transitions.
 *
 * This builds the result directly instead of handing it to
 * `parseSettingsStateV2`, the schema-2 state validator: that validator
 * recomputes each document's hash and compares it against
 * `activation.oldHash` / `candidateHash`, which the successor computed
 * against the original schema-3 bytes. A projected document hashes
 * differently, so that comparison would fail for a state that is
 * mid-activation even though nothing is actually wrong. Every field this
 * function copies unchanged - `activation`, `lastActivationOutcome`,
 * `lastTransaction`, and the revision numbers, already passed schema 3's
 * own equivalent structural checks (`server/settings-v3-state-validation.ts`),
 * so skipping the schema-2 re-check loses no real coverage.
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
    activation: state.activation,
    lastActivationOutcome: state.lastActivationOutcome,
    lastTransaction: state.lastTransaction
  });
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
 * when `settingsWriteSchemaVersion` resolves to 3. Production never takes
 * this path: `resolveImageInputActivation()` (shared/image-input-release.ts)
 * is a hardcoded false, so only a test that overrides it does.
 *
 * This supports the common non-credential-changing save shape only, where
 * `activation` is null throughout: every document in the revision table
 * upgrades independently (there is at most one such document while
 * `activation` is null, since a credential change is what stages a second,
 * pending revision), and no hash-bound `activation` record needs
 * recomputing against the upgraded documents. A save that changes which
 * credential a connection resolves stays a schema-2 write in this release:
 * building its schema-3 equivalent is the successor release's job, once it
 * carries its own schema-3 activation pipeline.
 */
export function upgradeSettingsStateV2ToV3(state: SettingsStateV2): SettingsStateV3 {
  if (state.activation !== null) {
    throw new Error(
      "Writing a schema-3 state mid-activation is not supported by this release; "
        + "only a clean, non-credential-changing save upgrades."
    );
  }
  const documents: Record<string, SettingsDocumentV3> = {};
  for (const [revision, document] of Object.entries(state.documents)) {
    documents[revision] = convertSettingsDocumentV2ToV3(document);
  }
  return parseSettingsStateV3({
    schemaVersion: 3,
    stateGeneration: state.stateGeneration,
    settingsRevisionClock: state.settingsRevisionClock,
    documents,
    activeRevision: state.activeRevision,
    pendingRevision: state.pendingRevision,
    previousRevision: state.previousRevision,
    activation: null,
    lastActivationOutcome: state.lastActivationOutcome,
    lastTransaction: state.lastTransaction
  });
}
