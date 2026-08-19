import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { SETTINGS_STATE_V2_FILE } from "../server/data-directory-layout.js";
import { hashSettingsStateV2, parseSettingsStateV2Bytes } from "../server/settings-v2-codec.js";
import {
  applyEffectiveGenerationSettings,
  effectiveGenerationSettings
} from "../server/settings-v2-conversion.js";
import { INITIAL_SETTINGS_DOCUMENT_V2 } from "../server/settings-v2-default.js";
import {
  parseSettingsStateSlotBytes,
  settingsStateSlotImageInputCapability,
  settingsStateSlotReadOnlyView
} from "../server/settings-state-slot.js";
import { SettingsV2Store } from "../server/settings-v2-store.js";
import { parseSettingsStateV3, formatSettingsStateV3 } from "../server/settings-v3-codec.js";
import { convertSettingsDocumentV2ToV3 } from "../server/settings-v3-conversion.js";
import { hashCanonicalSettingsDocument } from "../server/settings-v2-hash.js";
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
  credentialedDocument,
  hasServiceCode,
  initializedFormat2Directory,
  pauseNextFileRead,
  saveCommand,
  writingDocument
} from "./settings-store-fixtures.js";

/**
 * G1: schema 3 is defined but was not wired into the store. These tests
 * cover the wiring: a schema-3 state on disk opens and reads correctly, a
 * mutation against it refuses unconditionally without touching the file, an
 * ordinary schema-2 directory is unaffected, and every settings write stays
 * schema 2 — there is no switch, and no code path, that could ever write
 * schema 3 in this build.
 */

function statePath(dataDir: string): string {
  return path.join(dataDir, SETTINGS_STATE_V2_FILE);
}

async function sha256(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

/** The exact bytes `writeSuccessorSettingsState` below writes, without
 *  writing them: the byte length a caller needs to pause a read of this
 *  exact snapshot (`pauseNextFileRead`, test/settings-store-fixtures.ts). */
function successorStateText(document: SettingsDocumentV3): string {
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
  return formatSettingsStateV3(state);
}

/** Write a schema-3 settings state directly to disk, standing in for what a
 *  successor release would have written. `convertSettingsDocumentV2ToV3` is
 *  the already-built, already-tested schema migration; this only supplies a
 *  state envelope around it. */
async function writeSuccessorSettingsState(dataDir: string, document: SettingsDocumentV3): Promise<void> {
  await writeFile(statePath(dataDir), successorStateText(document), { mode: 0o600 });
}

/** A schema-3 state at generation 1, `stateGeneration: 1` matching what
 *  `initializedFormat2Directory` always starts a fresh directory at.
 *  `lastTransaction` names a "user" pointer the same way
 *  `writeSuccessorSettingsState` above does: `relation` is "clean"
 *  (`pendingRevision: null`), and `validateTransactionBinding`
 *  (server/settings-state-validation.ts) does not inspect a clean state's
 *  pointer contents beyond its shape, so this needs no matching ledger
 *  receipt to pass validation. A store only ever READS a schema-3 state
 *  (`requireMutableSettingsStateSlot`, server/settings-state-slot.ts, refuses
 *  every mutation against one, unconditionally), so it never reaches
 *  `recoverReceiptTransaction` and never needs a matching receipt to open
 *  it. */
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

/** `document` with one model's capabilities patched, standing in for a
 *  future override-storage feature this release does not build
 *  (`convertSettingsDocumentV2ToV3`'s doc comment,
 *  server/settings-v3-conversion.ts, explains why no production path can do
 *  this yet). */
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

test("a schema-3 settings state opens and every setting reads correctly", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-settings-successor-read-");
  const sourceDocument = credentialedDocument("IMAGE_INPUT_SUCCESSOR_READ_ENV");
  await writeSuccessorSettingsState(dataDir, convertSettingsDocumentV2ToV3(sourceDocument));

  // Every build reads a schema-3 authority the same way: there is no
  // settings activation switch to resolve differently.
  const store = new SettingsV2Store(dataDir, { now: () => FIXED_TIME });
  await store.init();

  const view = await store.loadView();
  assert.equal(view.editable, true);
  assert.equal(
    view.subscriptionAutoSelectEligible,
    false,
    "a successor-owned state cannot authorize the subscription draft default"
  );
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

test("every mutation against a schema-3 state refuses unconditionally and leaves the file byte identical", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-settings-successor-refuse-");
  await writeSuccessorSettingsState(
    dataDir,
    convertSettingsDocumentV2ToV3(credentialedDocument("IMAGE_INPUT_SUCCESSOR_REFUSE_ENV"))
  );
  const before = await sha256(statePath(dataDir));

  const store = new SettingsV2Store(dataDir, { now: () => FIXED_TIME });
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
 * The rollback guarantee's everyday case: every settings write stays schema
 * 2 (there is no successor settings writer in this build at all), so an
 * ordinary save stays schema 2 and a genuine predecessor reads and mutates
 * it exactly as if this release did not exist. This is G1's blocking
 * finding, from when this store still had an activation switch: it used to
 * upgrade every save unconditionally, which would have locked a writer's
 * rollback path for nothing gained.
 */
test("an ordinary save always stays schema 2, and a predecessor mutates it too", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-settings-successor-ordinary-save-");

  const writer = new SettingsV2Store(dataDir, { now: () => FIXED_TIME });
  await writer.init();
  await writer.save(saveCommand(MUTATION_A, 1, writingDocument("Written with activation on.")));
  const afterWrite = await readFile(statePath(dataDir));
  assert.equal(
    (JSON.parse(afterWrite.toString("utf8")) as { schemaVersion: unknown }).schemaVersion,
    2,
    "an ordinary save never upgrades a document with nothing to gain from schema 3"
  );

  // A fresh store over the exact same directory: an ordinary genuine
  // predecessor. Nothing special to prove here beyond ordinary schema-2
  // behavior, because that is exactly what this write produced.
  const reader = new SettingsV2Store(dataDir, { now: () => FIXED_TIME });
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
 * The rollback crash this branch fixes. A candidate revision that differs
 * from the active one ONLY by a model's `imageInput` projects to a
 * byte-identical schema-2 document once that field is dropped
 * (`downgradeSettingsDocumentV3ToV2`, server/settings-state-slot.ts) — the
 * ordinary case for exactly what a later release's capability-override
 * writer produces. Before the fix, an early activation switch let this
 * build treat a schema-3 authority as its own to mutate, so
 * `SettingsV2Store.init()` fell through to the schema-2 recovery pipeline,
 * which re-validates the downgraded documents map and throws on the two
 * byte-identical revisions.
 *
 * This release's settings writer never produces schema 3, and there is no
 * activation switch left to reconsider that:
 * `requireMutableSettingsStateSlot` (server/settings-state-slot.ts) refuses
 * a schema-3 slot unconditionally, the same way a genuine predecessor
 * always has. This test builds exactly the crashing pair and proves
 * `init()` opens the directory without writing anything and every mutation
 * is still refused.
 */
test("a rolled-back writer opens a schema-3 directory whose candidate revision differs from active only by a capability, and still refuses to mutate it", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-settings-successor-rollback-pair-");
  const modelId = "builtin:dry-run";
  const active = convertSettingsDocumentV2ToV3(INITIAL_SETTINGS_DOCUMENT_V2);
  const candidate = withModelCapabilities(active, modelId, { imageInput: "supported" });
  const state = parseSettingsStateV3({
    schemaVersion: 3,
    stateGeneration: 2,
    settingsRevisionClock: 2,
    documents: { "1": active, "2": candidate },
    activeRevision: 1,
    pendingRevision: 2,
    previousRevision: null,
    activation: {
      transactionId: MUTATION_A,
      oldHash: hashCanonicalSettingsDocument(active),
      candidateHash: hashCanonicalSettingsDocument(candidate),
      state: "validating",
      attempt: 1
    },
    lastActivationOutcome: null,
    lastTransaction: { receiptKind: "user", mutationId: MUTATION_A, phase: "prepared" }
  });
  await writeFile(statePath(dataDir), formatSettingsStateV3(state), { mode: 0o600 });
  const before = await sha256(statePath(dataDir));

  // No activation switch to override: the crash this proves fixed only
  // reproduced when an early build let activation make a schema-3 slot
  // mutable at all.
  const store = new SettingsV2Store(dataDir, { now: () => FIXED_TIME });
  await store.init();
  assert.equal(
    await sha256(statePath(dataDir)),
    before,
    "init() opens the directory without writing anything for a schema-3 authority it does not own"
  );

  await assert.rejects(
    store.save(saveCommand(MUTATION_B, 2, writingDocument("Must never reach disk."))),
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

test("a schema-2 directory still reads and saves exactly as before", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-settings-successor-v2-unaffected-");
  const store = new SettingsV2Store(dataDir, { now: () => FIXED_TIME });
  await store.init();

  const saved = await store.save(saveCommand(MUTATION_A, 1, writingDocument("Still schema 2.")));
  assert.equal(saved.settingsStateGeneration, 2);
  assert.equal((await store.loadView()).effective.systemPrompt, "Still schema 2.");

  const raw = JSON.parse(await readFile(statePath(dataDir), "utf8")) as { schemaVersion: unknown };
  assert.equal(raw.schemaVersion, 2);
});

/**
 * G1's blocking finding, under repetition: before this release removed the
 * successor settings writer entirely, this exact sequence (a fresh
 * directory, two ordinary saves in a row) upgraded to schema 3 on the first
 * save and stayed there, because an early activation switch was the whole
 * decision. Two consecutive saves prove every write stays schema 2 under
 * repetition, not only once.
 */
test("repeated ordinary saves never drift into schema 3", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-settings-successor-write-repeated-");
  const store = new SettingsV2Store(dataDir, { now: () => FIXED_TIME });
  await store.init();
  await store.save(saveCommand(MUTATION_A, 1, writingDocument("First write.")));
  const firstRaw = await readRawState(dataDir);
  assert.equal(firstRaw.schemaVersion, 2, "an ordinary save never upgrades a document with nothing to gain from schema 3");

  // A second save against the same directory, no restart: still schema 2,
  // because nothing about this document ever needed schema 3.
  await store.save(saveCommand(MUTATION_B, 2, writingDocument("Second write, still nothing to gain.")));
  const secondRaw = await readRawState(dataDir);
  assert.equal(secondRaw.schemaVersion, 2);
  assert.equal(
    (await store.loadView()).effective.systemPrompt,
    "Second write, still nothing to gain."
  );
});

interface RawSettingsState {
  readonly schemaVersion: unknown;
  readonly activeRevision: number;
  readonly documents: Record<string, { models: Record<string, { capabilities: ModelCapabilitiesV3 }> }>;
}

async function readRawState(dataDir: string): Promise<RawSettingsState> {
  return JSON.parse(await readFile(statePath(dataDir), "utf8")) as RawSettingsState;
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
 * This release's settings writer never produces schema 3 at all — there is
 * no successor settings writer in this build — so a schema-2 `current` can
 * never stage a schema-3 `.next` in the first place
 * (`stageSettingsState`'s doc comment, server/settings-state-file.ts). This
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
 * (`convertSettingsDocumentV2ToV3`'s doc comment, server/settings-v3-conversion.ts),
 * so both tests below construct a schema-3 document directly, standing in
 * for a future override-storage feature, and read it through the real
 * settings parser (`parseSettingsStateSlotBytes`) rather than inspecting the
 * document by hand.
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
  // `ImageInputContext` for this route would: `loadRuntime`'s own snapshot
  // (server/settings-v2-store.ts), the same one that resolves `settings`.
  const store = new SettingsV2Store(dataDir, { now: () => FIXED_TIME });
  await store.init();
  const stored = (await store.loadRuntime()).imageInputCapability;
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

  const store = new SettingsV2Store(dataDir, { now: () => FIXED_TIME });
  await store.init();
  const stored = (await store.loadRuntime()).imageInputCapability;
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
 * Finding A (image-activate review, round 2): `settings` and its stored
 * `imageInputCapability` must come out of ONE read of the settings-state
 * authority, not two independent ones. Two independent reads let a settings
 * replacement land between them and pair one snapshot's provider settings
 * with a DIFFERENT snapshot's stored capability verdict. That mismatch is
 * dangerous in exactly one direction: a stored `"supported"` wins over exact
 * built-in knowledge (see the two tests above), so it can authorize an image
 * that then gets dispatched with a DIFFERENT snapshot's provider settings —
 * possibly one with no image-capable endpoint at all.
 *
 * `SettingsV2Store.loadRuntime` (server/settings-v2-store.ts) now resolves
 * both values from its own single `readRuntimeSnapshot` read. This test
 * proves the pairing survives a replacement landing mid-read: it pauses that
 * read after it opens the file but before it finishes, replaces the file on
 * disk with a snapshot naming a different model and a different stored
 * verdict, then releases the pause. `test/settings-state-atomic-read.test.ts`
 * already proves the underlying guarantee this relies on - a paused read of
 * an atomically-replaced mutable authority resolves to the snapshot that was
 * active when the read opened the file, never a torn mix. If `loadRuntime`
 * regressed to reading settings and the stored capability through two
 * separate reads of the file (the shape this finding reported), the second
 * read would land after the replacement and this test would observe
 * `settings` from the OLD snapshot paired with `imageInputCapability` from
 * the NEW one.
 */
test("a settings replacement landing mid-read cannot pair one snapshot's settings with a different snapshot's stored capability", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-settings-successor-atomic-");
  const modelId = "builtin:dry-run";
  const oldDocument = withModelCapabilities(
    convertSettingsDocumentV2ToV3(anthropicCredentialedDocument("IMAGE_INPUT_ATOMIC_OLD_ENV", "model-old")),
    modelId,
    { imageInput: "unsupported" }
  );
  const newDocument = withModelCapabilities(
    convertSettingsDocumentV2ToV3(anthropicCredentialedDocument("IMAGE_INPUT_ATOMIC_NEW_ENV", "model-new")),
    modelId,
    { imageInput: "supported", imageTokenCeiling: 4_096 }
  );
  const oldText = successorStateText(oldDocument);
  const newText = successorStateText(newDocument);
  await writeFile(statePath(dataDir), oldText, { mode: 0o600 });

  const store = new SettingsV2Store(dataDir, { now: () => FIXED_TIME });
  await store.init();

  const pause = await pauseNextFileRead(t, Buffer.byteLength(oldText, "utf8") + 1);
  const reading = store.loadRuntime();
  await pause.entered;
  // The swap-then-rename shape a real save uses (`publishSettingsFile`,
  // server/settings-file-io.ts): a plain in-place `writeFile` over the same
  // path would edit the very inode the paused read has open, which the
  // reader's own change-detection would reject as corruption rather than
  // silently tear. A rename over the path leaves the open read's file
  // descriptor pointing at the untouched old inode.
  const swapPath = `${statePath(dataDir)}.atomic-swap`;
  try {
    await writeFile(swapPath, newText, { mode: 0o600 });
    await rename(swapPath, statePath(dataDir));
  } finally {
    pause.release();
  }

  const runtime = await reading;
  assert.equal(
    runtime.settings.model,
    "model-old",
    "settings must come from the snapshot active when the read began"
  );
  assert.deepEqual(
    runtime.imageInputCapability,
    { imageInput: "unsupported", imageTokenCeiling: undefined },
    "the stored capability must come from the SAME snapshot as settings, not one that landed mid-read"
  );

  // Sanity: the replacement really did land, and a fresh read after this one
  // sees it - proving the assertion above passes because the pairing held,
  // not because the swap silently failed to take effect.
  const after = await store.loadRuntime();
  assert.equal(after.settings.model, "model-new");
  assert.deepEqual(after.imageInputCapability, { imageInput: "supported", imageTokenCeiling: 4_096 });
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
