import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { SETTINGS_STATE_V2_FILE } from "../server/data-directory-layout.js";
import { MutationLedgerStore } from "../server/mutation-ledger-store.js";
import type { MutationId } from "../server/mutation-ledger-types.js";
import { hashSettingsStateV2, parseSettingsStateV2Bytes } from "../server/settings-v2-codec.js";
import {
  applyEffectiveGenerationSettings,
  effectiveGenerationSettings
} from "../server/settings-v2-conversion.js";
import { INITIAL_SETTINGS_DOCUMENT_V2, INITIAL_SETTINGS_STATE_V2 } from "../server/settings-v2-default.js";
import { completeSettingsMutation } from "../server/settings-v2-mutation.js";
import {
  parseSettingsStateSlotBytes,
  settingsStateSlotImageInputCapability,
  settingsStateSlotReadOnlyView
} from "../server/settings-state-slot.js";
import { SettingsV2Store } from "../server/settings-v2-store.js";
import { parseSettingsStateV3, formatSettingsStateV3 } from "../server/settings-v3-codec.js";
import { convertSettingsDocumentV2ToV3, settingsStateNeedsSuccessorSchema } from "../server/settings-v3-conversion.js";
import type {
  ModelCapabilitiesV3,
  SettingsDocumentV2,
  SettingsDocumentV3,
  SettingsStateV3
} from "../shared/settings-v2-types.js";
import { MAX_CREDENTIAL_NAMES_PER_STATE } from "../shared/credential-slot-policy.js";
import { settingsStateCredentialNames } from "../shared/settings-credential-slots.js";
import { imageInputAuthorized, resolveImageInputCapability } from "../shared/image-input-capabilities.js";
import {
  FIXED_TIME,
  MUTATION_A,
  MUTATION_B,
  MUTATION_C,
  credentialedDocument,
  hasServiceCode,
  initializedFormat2Directory,
  preparedFixture,
  saveCommand,
  writingDocument
} from "./settings-store-fixtures.js";

/**
 * G1: schema 3 is defined but was not wired into the store. These tests
 * cover the wiring: a schema-3 state on disk opens and reads correctly, a
 * mutation against it refuses without touching the file, an ordinary
 * schema-2 directory is unaffected, and the write-schema decision produces
 * the schema the caller asked for.
 */

function statePath(dataDir: string): string {
  return path.join(dataDir, SETTINGS_STATE_V2_FILE);
}

async function sha256(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

/** Write a schema-3 settings state directly to disk, standing in for what a
 *  successor release would have written. `convertSettingsDocumentV2ToV3` is
 *  the already-built, already-tested schema migration; this only supplies a
 *  state envelope around it. */
async function writeSuccessorSettingsState(dataDir: string, document: SettingsDocumentV3): Promise<void> {
  const state = parseSettingsStateV3({
    schemaVersion: 3,
    stateGeneration: 2,
    settingsRevisionClock: 1,
    documents: { "1": document },
    activeRevision: 1,
    pendingRevision: null,
    previousRevision: null,
    activation: null,
    lastActivationOutcome: null,
    lastTransaction: { receiptKind: "user", mutationId: MUTATION_A, phase: "prepared" }
  });
  await writeFile(statePath(dataDir), formatSettingsStateV3(state), { mode: 0o600 });
}

/** A schema-3 state at generation 1, `stateGeneration: 1` matching what
 *  `initializedFormat2Directory` always starts a fresh directory at.
 *  `lastTransaction` names a "user" pointer the same way
 *  `writeSuccessorSettingsState` above does: `relation` is "clean"
 *  (`pendingRevision: null`), and `validateTransactionBinding`
 *  (server/settings-state-validation.ts) does not inspect a clean state's
 *  pointer contents beyond its shape, so this needs no matching ledger
 *  receipt to pass validation. A store that only ever READS this (activation
 *  false at `init()`, the early "v3-requires-successor" branch) never
 *  reaches `recoverReceiptTransaction` either, so it needs no matching
 *  receipt to open it. A store that must WRITE against this seed needs one;
 *  see `seedWritableSuccessorState` below, which supplies it. */
function settledSuccessorSettingsState(document: SettingsDocumentV3): SettingsStateV3 {
  return parseSettingsStateV3({
    schemaVersion: 3,
    stateGeneration: 1,
    settingsRevisionClock: 1,
    documents: { "1": document },
    activeRevision: 1,
    pendingRevision: null,
    previousRevision: null,
    activation: null,
    lastActivationOutcome: null,
    lastTransaction: { receiptKind: "user", mutationId: MUTATION_A, phase: "prepared" }
  });
}

async function writeSettledSuccessorSettingsState(dataDir: string, state: SettingsStateV3): Promise<void> {
  await writeFile(statePath(dataDir), formatSettingsStateV3(state), { mode: 0o600 });
}

/** Write `state` to disk AND a matching completed ledger receipt for its
 *  `lastTransaction` pointer, so a `SettingsV2Store` whose activation makes
 *  this authority mutable can actually complete `recoverReceiptTransaction`
 *  (server/settings-v2-store.ts) against it and go on to save. Without a
 *  matching receipt, that same call throws `corruptSettingsStateReceipt`,
 *  because a non-null "user" pointer with nothing recorded for it looks like
 *  a crash mid-transaction, not a settled state. The situation
 *  `writeSettledSuccessorSettingsState` above is for read-only fixtures,
 *  where a store never reaches this check, cannot stand in for.
 *
 *  The receipt binds by hash to `state`'s own schema-2 read-only view (the
 *  shape `recoverReceiptTransaction` actually hashes and compares), parsed
 *  through the real `parseSettingsStateSlotBytes`/`settingsStateSlotReadOnlyView`
 *  path rather than reconstructed by hand. */
async function seedWritableSuccessorState(
  dataDir: string,
  ledger: MutationLedgerStore,
  mutationId: MutationId,
  state: SettingsStateV3
): Promise<void> {
  const pointer = state.lastTransaction;
  if (pointer?.receiptKind !== "user" || pointer.mutationId !== mutationId) {
    throw new Error("fixture state's lastTransaction must name mutationId");
  }
  await writeSettledSuccessorSettingsState(dataDir, state);
  const downgraded = settingsStateSlotReadOnlyView(
    parseSettingsStateSlotBytes(Buffer.from(formatSettingsStateV3(state), "utf8"))
  );
  // `current` only needs to differ from `next` (a completed mutation's
  // aggregate hash must actually change); its exact content is otherwise
  // unchecked by `recoverReceiptTransaction`, which cares only about
  // `newStateHash` and `result` below.
  const prepared = preparedFixture(mutationId, INITIAL_SETTINGS_STATE_V2, downgraded);
  await ledger.init();
  await ledger.writeUserRecord(prepared);
  await ledger.writeUserRecord(completeSettingsMutation(prepared, FIXED_TIME.toISOString()));
}

/** `document` with one model's capabilities patched, standing in for a
 *  future override-storage feature this release does not build
 *  (server/settings-v3-conversion.ts's `settingsStateNeedsSuccessorSchema`
 *  doc comment explains why no production path can do this yet). */
function withModelCapabilities(
  document: SettingsDocumentV3,
  modelId: string,
  patch: Partial<ModelCapabilitiesV3>
): SettingsDocumentV3 {
  const model = document.models[modelId];
  if (model === undefined) throw new Error(`fixture model ${modelId} is missing`);
  return {
    ...document,
    models: {
      ...document.models,
      [modelId]: { ...model, capabilities: { ...model.capabilities, ...patch } }
    }
  };
}

/** A settings document routed to an Anthropic connection naming `remoteId`,
 *  the way `credentialedDocument` (settings-store-fixtures.ts) builds one
 *  for `openai-compatible`. Needed here, rather than reused from there,
 *  because `resolveImageInputCapability`'s built-in vision table
 *  (shared/image-input-capabilities.ts) is keyed by exact Anthropic model
 *  IDs, and the OpenAI-compatible fixture cannot name one. */
function anthropicCredentialedDocument(environmentName: string, remoteId: string): SettingsDocumentV2 {
  return applyEffectiveGenerationSettings(INITIAL_SETTINGS_DOCUMENT_V2, {
    ...effectiveGenerationSettings(INITIAL_SETTINGS_DOCUMENT_V2),
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    model: remoteId,
    apiKeyEnv: environmentName
  });
}

test("a schema-3 settings state opens and every setting reads correctly, activation off", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-settings-successor-read-");
  const sourceDocument = credentialedDocument("IMAGE_INPUT_SUCCESSOR_READ_ENV");
  await writeSuccessorSettingsState(dataDir, convertSettingsDocumentV2ToV3(sourceDocument));

  // A predecessor that resolves activation off: this build's own default is
  // on, so the override is explicit, the same way every other
  // predecessor-refusal fixture in this suite proves it.
  const store = new SettingsV2Store(dataDir, { now: () => FIXED_TIME, imageInputActivation: false });
  await store.init();

  const view = await store.loadView();
  assert.equal(view.editable, true);
  assert.equal(view.document?.schemaVersion, 2, "the store presents a schema-2 read-only view");
  const capabilities = view.document?.models["builtin:dry-run"]?.capabilities;
  assert.equal(capabilities?.temperature, "supported");
  assert.ok(
    capabilities !== undefined && !("imageInput" in capabilities),
    "the successor-only field never reaches a schema-2 read-only view"
  );
  assert.deepEqual(
    view.document?.connections["builtin:dry-run"]?.auth,
    { type: "bearer-env", env: "IMAGE_INPUT_SUCCESSOR_READ_ENV" }
  );

  const effective = await store.loadEffective();
  assert.equal(effective.provider, "openai-compatible");
  assert.equal(effective.baseUrl, "https://api.openai.com/v1");
  assert.equal(effective.model, "test-model");
  assert.equal(effective.apiKeyEnv, "IMAGE_INPUT_SUCCESSOR_READ_ENV");
});

test("every mutation against a schema-3 state refuses and leaves the file byte identical, activation off", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-settings-successor-refuse-");
  await writeSuccessorSettingsState(
    dataDir,
    convertSettingsDocumentV2ToV3(credentialedDocument("IMAGE_INPUT_SUCCESSOR_REFUSE_ENV"))
  );
  const before = await sha256(statePath(dataDir));

  // A predecessor that resolves activation off: see the read test above for
  // why the override is explicit in this build.
  const store = new SettingsV2Store(dataDir, { now: () => FIXED_TIME, imageInputActivation: false });
  await store.init();
  assert.equal(await sha256(statePath(dataDir)), before, "init() never writes for a schema-3 authority it cannot own");

  await assert.rejects(
    store.save(saveCommand(MUTATION_B, 2, writingDocument("Blocked by the successor schema."))),
    hasServiceCode("settings_requires_successor")
  );
  assert.equal(await sha256(statePath(dataDir)), before, "a refused save leaves the file untouched");

  await assert.rejects(
    store.discardPending({
      transportOperationId: "transport:discard",
      mutationId: MUTATION_B,
      expectedStateGeneration: 2
    }),
    hasServiceCode("settings_requires_successor")
  );
  assert.equal(await sha256(statePath(dataDir)), before, "a refused discard leaves the file untouched");
});

/**
 * The rollback guarantee's everyday case: this build's own default
 * activation is on, but an ordinary save has nothing that needs schema 3
 * (`settingsStateNeedsSuccessorSchema`, server/settings-v3-conversion.ts, is
 * false for it), so it stays schema 2 and a genuine predecessor reads and
 * mutates it exactly as if this release did not exist. This is G1's
 * blocking finding: activation alone used to upgrade every save
 * unconditionally, which would have locked a writer's rollback path for
 * nothing gained.
 */
test("a real save with activation on but nothing that needs schema 3 stays schema 2, and a predecessor mutates it too", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-settings-successor-ordinary-save-");

  const writer = new SettingsV2Store(dataDir, { now: () => FIXED_TIME });
  await writer.init();
  await writer.save(saveCommand(MUTATION_A, 1, writingDocument("Written with activation on.")));
  const afterWrite = await readFile(statePath(dataDir));
  assert.equal(
    (JSON.parse(afterWrite.toString("utf8")) as { schemaVersion: unknown }).schemaVersion,
    2,
    "activation alone never upgrades a document with nothing to gain from schema 3"
  );

  // A fresh store over the exact same directory, a genuine predecessor that
  // resolves activation off. Nothing special to prove here beyond ordinary
  // schema-2 behavior, because that is exactly what this write produced.
  const reader = new SettingsV2Store(dataDir, { now: () => FIXED_TIME, imageInputActivation: false });
  await reader.init();
  assert.equal(
    (await reader.loadView()).effective.systemPrompt,
    "Written with activation on.",
    "a predecessor reads the ordinary save correctly"
  );
  await reader.save(saveCommand(MUTATION_B, 2, writingDocument("A predecessor can still mutate it.")));
  assert.equal(
    (await reader.loadView()).effective.systemPrompt,
    "A predecessor can still mutate it."
  );
});

/**
 * The rollback guarantee's other half, for the document that genuinely
 * needs schema 3. No production code path can construct that document yet
 * (`settingsStateNeedsSuccessorSchema`'s doc comment explains why), so this
 * test seeds one directly with `seedWritableSuccessorState`, standing in for
 * a future release's override-storage feature, the same way
 * `writeSuccessorSettingsState` above stands in for a successor release's
 * write in the read/refuse tests near it. From there it drives the real
 * write path (`SettingsV2Store.save`) to prove: an unrelated, ordinary edit
 * on top of that seed carries the override forward and stays on schema 3,
 * and a genuine predecessor is correctly refused rather than silently
 * handed a document that lost the writer's override.
 */
test("a save against a document that genuinely needs schema 3 stays on it, carries the value forward, and is refused by a predecessor", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-settings-successor-needs-schema-3-");
  const modelId = "builtin:dry-run";
  const seeded = withModelCapabilities(
    convertSettingsDocumentV2ToV3(INITIAL_SETTINGS_DOCUMENT_V2),
    modelId,
    // Dry run's own fresh-migration default is always "unsupported"
    // (server/settings-v3-conversion.ts); "supported" is a value only a
    // future override could ever record, so `settingsStateNeedsSuccessorSchema`
    // must treat it as non-derivable.
    { imageInput: "supported" }
  );
  const priorState = settledSuccessorSettingsState(seeded);
  // The predicate itself, ahead of driving a real save through it: the
  // ordinary candidate document below carries the same model identity
  // (connection, remote ID, protocol) as `priorState`'s, so the seeded
  // override is exactly what makes this true.
  assert.equal(
    settingsStateNeedsSuccessorSchema(
      { ...INITIAL_SETTINGS_STATE_V2, documents: { "1": INITIAL_SETTINGS_DOCUMENT_V2 } },
      priorState
    ),
    true,
    "settingsStateNeedsSuccessorSchema recognizes the seeded override as non-derivable"
  );
  const ledger = new MutationLedgerStore(dataDir);
  await seedWritableSuccessorState(dataDir, ledger, MUTATION_A, priorState);

  const writer = new SettingsV2Store(dataDir, { now: () => FIXED_TIME, ledger });
  await writer.init();
  // An unrelated, ordinary edit: only the writing brief changes, so this
  // never touches credentials and never stages, taking the reducer's
  // immediate path (server/settings-v2-reducer.ts's `saveDocument`). A fresh mutation
  // ID: MUTATION_A is already spent, seeding the state above.
  await writer.save(saveCommand(
    MUTATION_B,
    1,
    { ...INITIAL_SETTINGS_DOCUMENT_V2, writing: { defaultAuthorBrief: "An ordinary edit that must not lose the override." } }
  ));
  const afterWrite = await readRawState(dataDir);
  assert.equal(afterWrite.schemaVersion, 3, "the document still needs schema 3, so the write stays on it");
  assert.equal(
    activeModelCapabilities(afterWrite).imageInput,
    "supported",
    "the unrelated edit carries the override forward instead of resetting it"
  );

  // A genuine predecessor, activation explicitly off: refused, and the file
  // stays byte identical, exactly like every other successor-schema refusal
  // in this suite.
  const reader = new SettingsV2Store(dataDir, { now: () => FIXED_TIME, imageInputActivation: false });
  await reader.init();
  const beforeRefusal = await readFile(statePath(dataDir));
  await assert.rejects(
    reader.save(saveCommand(MUTATION_C, 2, writingDocument("Must never reach disk."))),
    hasServiceCode("settings_requires_successor")
  );
  assert.deepEqual(
    await readFile(statePath(dataDir)),
    beforeRefusal,
    "a refused save leaves the file byte identical, never corrupted"
  );
});

test("a schema-2 directory still reads and saves exactly as before, activation off", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-settings-successor-v2-unaffected-");
  // A predecessor that resolves activation off: see the read test above for
  // why the override is explicit in this build, even though an ordinary save
  // stays schema 2 either way today (test/settings-store-release-a.test.ts's
  // "the settings write schema version needs both activation and a
  // non-derivable value to reach schema 3" covers the full truth table).
  const store = new SettingsV2Store(dataDir, { now: () => FIXED_TIME, imageInputActivation: false });
  await store.init();

  const saved = await store.save(saveCommand(MUTATION_A, 1, writingDocument("Still schema 2.")));
  assert.equal(saved.settingsStateGeneration, 2);
  assert.equal((await store.loadView()).effective.systemPrompt, "Still schema 2.");

  const raw = JSON.parse(await readFile(statePath(dataDir), "utf8")) as { schemaVersion: unknown };
  assert.equal(raw.schemaVersion, 2);
});

/**
 * G1's blocking finding, under repetition: before `settingsStateNeedsSuccessorSchema`
 * existed, this exact sequence (a fresh directory, this build's own default
 * activation, two ordinary saves in a row) upgraded to schema 3 on the
 * first save and stayed there, because activation alone was the whole
 * decision. Two consecutive saves prove the gate holds under repetition, not
 * only once.
 */
test("repeated ordinary saves never drift into schema 3, with activation on or off", async (t) => {
  const defaultDir = await initializedFormat2Directory(t, "1667-settings-successor-write-default-");
  const defaultStore = new SettingsV2Store(defaultDir, { now: () => FIXED_TIME });
  await defaultStore.init();
  await defaultStore.save(saveCommand(MUTATION_A, 1, writingDocument("First write, activation on.")));
  const firstRaw = await readRawState(defaultDir);
  assert.equal(firstRaw.schemaVersion, 2, "activation alone never upgrades a first save with nothing to gain");

  // A second save against the same directory, no restart: still schema 2,
  // because nothing about this document ever needed schema 3.
  await defaultStore.save(saveCommand(MUTATION_B, 2, writingDocument("Second write, still nothing to gain.")));
  const secondRaw = await readRawState(defaultDir);
  assert.equal(secondRaw.schemaVersion, 2);
  assert.equal(
    (await defaultStore.loadView()).effective.systemPrompt,
    "Second write, still nothing to gain."
  );

  // A store that explicitly resolves activation false, a genuine
  // predecessor: schema 2 for the same reason as above, not merely because
  // activation happens to be off too.
  const offDir = await initializedFormat2Directory(t, "1667-settings-successor-write-off-");
  const offStore = new SettingsV2Store(offDir, { now: () => FIXED_TIME, imageInputActivation: false });
  await offStore.init();
  await offStore.save(saveCommand(MUTATION_A, 1, writingDocument("Explicit-off write stays schema 2.")));
  assert.equal((await readRawState(offDir)).schemaVersion, 2);
});

interface RawSettingsState {
  readonly schemaVersion: unknown;
  readonly activeRevision: number;
  readonly documents: Record<string, { models: Record<string, { capabilities: ModelCapabilitiesV3 }> }>;
}

async function readRawState(dataDir: string): Promise<RawSettingsState> {
  return JSON.parse(await readFile(statePath(dataDir), "utf8")) as RawSettingsState;
}

function activeModelCapabilities(raw: RawSettingsState): ModelCapabilitiesV3 {
  const capabilities = raw.documents[String(raw.activeRevision)]?.models["builtin:dry-run"]?.capabilities;
  if (capabilities === undefined) throw new Error("active document has no builtin:dry-run model");
  return capabilities;
}

/**
 * Finding 2: the round-trip test above proves the CURRENT-file case, but it
 * stands in for the predecessor using THIS branch's own tolerant reader
 * (`parseSettingsStateSlotBytes`, server/settings-state-slot.ts), which
 * falls back to a schema-3 parse when the schema-2 one fails. A predecessor's
 * `.next` reader never gained that fallback, because nothing wrote a
 * schema-3 `.next` before this branch (`readSettingsStateFiles`'s v0.8.0
 * comment said "nothing here ever writes one"). This fixture proves the gap
 * directly, with v0.8.0's own strict parser (`parseSettingsStateV2Bytes`,
 * server/settings-v2-codec.ts, unchanged by this branch, verified by diff
 * against origin/main): a schema-3 `.next` residue left behind by a crash
 * mid-activation is a document a predecessor cannot even parse, let alone
 * refuse gracefully. Its store would fail to initialize.
 *
 * `server/settings-state-file.ts`'s `formatSettingsStateForWrite` closes most
 * of this by construction: it reads its own `current` file fresh, at the
 * moment it stages a `.next`, so a schema-2 `current` can never stage a
 * schema-3 `.next` in the first place (see that function's doc comment). This
 * fixture is the reason that guarantee has to hold, kept as a fixture rather
 * than only a code comment, and it is exactly what the tolerant round-trip
 * test above cannot see.
 */
test("a schema-3 .next residue cannot be parsed by the predecessor's own strict next-file reader", () => {
  const document = convertSettingsDocumentV2ToV3(credentialedDocument("IMAGE_INPUT_NEXT_RESIDUE_ENV"));
  const state = settledSuccessorSettingsState(document);
  const bytes = Buffer.from(formatSettingsStateV3(state), "utf8");
  assert.throws(
    () => parseSettingsStateV2Bytes(bytes),
    /schemaVersion must be 2/,
    "v0.8.0's `.next` reader is strict schema-2-only; unlike its `current` reader, it has no schema-3 fallback"
  );
});

/**
 * The addendum finding: a stored `imageInput`/`imageTokenCeiling` override
 * must reach `resolveImageInputCapability` (shared/image-input-capabilities.ts)
 * as its documented explicit override, not be silently dropped by the read
 * path. No production code path can store one yet
 * (`settingsStateNeedsSuccessorSchema`'s doc comment), so both tests below
 * construct a schema-3 document directly, standing in for a future
 * override-storage feature, and read it through the real settings parser
 * (`parseSettingsStateSlotBytes`) rather than inspecting the document by
 * hand.
 *
 * This is the dangerous direction: a writer marks a model `imageInput:
 * "unsupported"` even though it is one this build's own built-in table
 * (`ANTHROPIC_PATCH_MODELS`, shared/image-input-capabilities.ts) would
 * otherwise resolve `"supported"` for. Dropping the override on read would
 * silently reverse the writer's explicit "no" and send an image to a model
 * they said cannot read one. Proven directly below, by resolving the SAME
 * route with no override at all first.
 */
test("a stored imageInput \"unsupported\" override reaches the resolver and blocks a model the built-in table would otherwise authorize", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-settings-successor-override-blocks-");
  const remoteId = "claude-sonnet-5";
  const modelId = "builtin:dry-run";
  const document = withModelCapabilities(
    convertSettingsDocumentV2ToV3(anthropicCredentialedDocument("IMAGE_INPUT_OVERRIDE_BLOCKS_ENV", remoteId)),
    modelId,
    { imageInput: "unsupported" }
  );
  await writeSettledSuccessorSettingsState(dataDir, settledSuccessorSettingsState(document));

  // Without the stored override, the built-in table alone authorizes this
  // exact route: this is the silent reversal a dropped override would cause.
  const withoutOverride = resolveImageInputCapability({
    protocol: "anthropic-messages",
    remoteModelId: remoteId
  });
  assert.equal(imageInputAuthorized(withoutOverride), true, "sanity: the built-in table alone would authorize this model");

  // Read through the real path, exactly like a caller building an
  // `ImageInputContext` for this route would (server/settings-state-slot.ts's
  // `settingsStateSlotImageInputCapability` doc comment).
  const store = new SettingsV2Store(dataDir, { now: () => FIXED_TIME, imageInputActivation: false });
  await store.init();
  const stored = await store.loadImageInputCapability();
  assert.deepEqual(stored, { imageInput: "unsupported", imageTokenCeiling: undefined });

  const resolution = resolveImageInputCapability({
    protocol: "anthropic-messages",
    remoteModelId: remoteId,
    override: stored?.imageInput,
    overrideTokenCeiling: stored?.imageTokenCeiling
  });
  assert.equal(resolution.support, "unsupported");
  assert.equal(imageInputAuthorized(resolution), false, "the stored override reaches the resolver and wins over built-in knowledge");
});

/**
 * The mirror direction: a stored `imageInput: "supported"` override, paired
 * with `imageTokenCeiling`, authorizes an image for a model the built-in
 * table has never heard of, provided a safe token strategy exists, which is
 * exactly what the paired ceiling supplies
 * (`resolveImageInputCapability`'s own resolution order:
 * shared/image-input-capabilities.ts). This is what makes the override worth
 * storing at all: without it, an unlisted model can never be authorized, no
 * matter what the writer knows about it.
 */
test("a stored imageInput \"supported\" override with a token ceiling authorizes a model absent from the built-in table", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-settings-successor-override-authorizes-");
  const modelId = "builtin:dry-run";
  const document = withModelCapabilities(
    convertSettingsDocumentV2ToV3(credentialedDocument("IMAGE_INPUT_OVERRIDE_AUTHORIZES_ENV")),
    modelId,
    { imageInput: "supported", imageTokenCeiling: 4_096 }
  );
  await writeSettledSuccessorSettingsState(dataDir, settledSuccessorSettingsState(document));

  // "test-model" (credentialedDocument's remote ID) is in no built-in table,
  // so with no override it can never be authorized.
  const withoutOverride = resolveImageInputCapability({
    protocol: "openai-chat-completions",
    remoteModelId: "test-model"
  });
  assert.equal(imageInputAuthorized(withoutOverride), false, "sanity: an unlisted model is never authorized without an override");

  const store = new SettingsV2Store(dataDir, { now: () => FIXED_TIME, imageInputActivation: false });
  await store.init();
  const stored = await store.loadImageInputCapability();
  assert.deepEqual(stored, { imageInput: "supported", imageTokenCeiling: 4_096 });

  const resolution = resolveImageInputCapability({
    protocol: "openai-chat-completions",
    remoteModelId: "test-model",
    override: stored?.imageInput,
    overrideTokenCeiling: stored?.imageTokenCeiling
  });
  assert.equal(resolution.support, "supported");
  assert.equal(imageInputAuthorized(resolution), true);
  assert.deepEqual(
    resolution.support === "supported" ? resolution.strategy : null,
    { kind: "explicit-ceiling", ceiling: 4_096 }
  );
});

/**
 * `server/settings-state-validation.ts` enforces
 * `MAX_CREDENTIAL_NAMES_PER_STATE` across a state's documents.
 * `server/settings-v3-state-validation.ts` ran the same five validators but
 * skipped that one, because `settingsStateCredentialNames`
 * (shared/settings-credential-slots.ts) was typed to accept only
 * `SettingsDocumentV2`, and a `SettingsDocumentV3` is not assignable to it
 * (their `schemaVersion` literals differ). The fix widens that helper to the
 * structural shape it actually needs - `connections`, identical on both
 * document versions, and calls it from both validators.
 *
 * The per-document credential cap (32) times the at most two documents a
 * real settings state ever holds already bounds a normally parsed state at
 * exactly 64, so this exact state-wide check can never fire by handing
 * `validateSettingsStateV3` well-formed JSON: the same "defence in depth,
 * unreachable by construction" shape the Draft Image byte quotas have
 * (G6 in FOLLOWUPS.md). This test exercises the aggregation function the
 * guard calls directly, with more documents than a real state ever holds
 * standing in for what an incorrectly assembled one could carry, and proves
 * it now sums schema-3 documents exactly like it always summed schema-2
 * ones.
 */
test("settingsStateCredentialNames sums schema-3 documents toward the same state-wide bound schema 2 uses", () => {
  const documentCount = MAX_CREDENTIAL_NAMES_PER_STATE + 1;
  const documents: Record<string, SettingsDocumentV3> = {};
  for (let index = 0; index < documentCount; index += 1) {
    documents[String(index + 1)] = convertSettingsDocumentV2ToV3(
      credentialedDocument(`IMAGE_INPUT_STATE_BOUND_ENV_${index}`)
    );
  }
  const names = settingsStateCredentialNames({ documents });
  assert.equal(names.length, documentCount);
  assert.ok(
    names.length > MAX_CREDENTIAL_NAMES_PER_STATE,
    "server/settings-v3-state-validation.ts's new guard must refuse a state this large"
  );
});
