import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { SETTINGS_STATE_V2_FILE } from "../server/data-directory-layout.js";
import { SettingsV2Store } from "../server/settings-v2-store.js";
import { parseSettingsStateV3, formatSettingsStateV3 } from "../server/settings-v3-codec.js";
import { convertSettingsDocumentV2ToV3 } from "../server/settings-v3-conversion.js";
import type { SettingsDocumentV3, ModelCapabilitiesV3 } from "../shared/settings-v2-types.js";
import { MAX_CREDENTIAL_NAMES_PER_STATE } from "../shared/credential-slot-policy.js";
import { settingsStateCredentialNames } from "../shared/settings-credential-slots.js";
import {
  FIXED_TIME,
  MUTATION_A,
  MUTATION_B,
  credentialedDocument,
  hasServiceCode,
  initializedFormat2Directory,
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
 * The rollback guarantee itself, proven end to end rather than by
 * inspection: a document a real save actually wrote with activation on is
 * read correctly, and refused rather than corrupted, by a fresh store that
 * resolves activation off. That fresh store stands in for a genuine
 * predecessor, or this same build after a rollback.
 * `writeSuccessorSettingsState` above stands in for this exact outcome in
 * the read/refuse tests near it, built by hand from
 * `convertSettingsDocumentV2ToV3` so those tests can stay narrowly about the
 * read and refusal mechanics; this test instead drives the real write path
 * (`SettingsV2Store.save`) to prove the mechanics they assume are actually
 * true of it.
 */
test("a real save with activation on is read correctly, and refused rather than corrupted, by activation off", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-settings-successor-roundtrip-");

  const writer = new SettingsV2Store(dataDir, { now: () => FIXED_TIME });
  await writer.init();
  await writer.save(saveCommand(MUTATION_A, 1, writingDocument("Written with activation on.")));
  const afterWrite = await readFile(statePath(dataDir));
  assert.equal(
    (JSON.parse(afterWrite.toString("utf8")) as { schemaVersion: unknown }).schemaVersion,
    3,
    "the real save path reaches schema 3 with this build's own default activation"
  );

  // A fresh store over the exact same directory, a genuine predecessor that
  // resolves activation off.
  const reader = new SettingsV2Store(dataDir, { now: () => FIXED_TIME, imageInputActivation: false });
  await reader.init();
  assert.equal(
    (await reader.loadView()).effective.systemPrompt,
    "Written with activation on.",
    "a predecessor reads the successor's document correctly"
  );

  await assert.rejects(
    reader.save(saveCommand(MUTATION_B, 2, writingDocument("Must never reach disk."))),
    hasServiceCode("settings_requires_successor")
  );
  assert.deepEqual(
    await readFile(statePath(dataDir)),
    afterWrite,
    "a refused save leaves the file byte identical, never corrupted"
  );
});

test("a schema-2 directory still reads and saves exactly as before, activation off", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-settings-successor-v2-unaffected-");
  // A predecessor that resolves activation off: see the read test above for
  // why the override is explicit in this build. Without it this release's
  // own default writes schema 3 (test/settings-store-release-a.test.ts's
  // "the settings write schema version defaults to the image-input
  // activation constant" covers that default directly).
  const store = new SettingsV2Store(dataDir, { now: () => FIXED_TIME, imageInputActivation: false });
  await store.init();

  const saved = await store.save(saveCommand(MUTATION_A, 1, writingDocument("Still schema 2.")));
  assert.equal(saved.settingsStateGeneration, 2);
  assert.equal((await store.loadView()).effective.systemPrompt, "Still schema 2.");

  const raw = JSON.parse(await readFile(statePath(dataDir), "utf8")) as { schemaVersion: unknown };
  assert.equal(raw.schemaVersion, 2);
});

test("the write-schema decision defaults to this build's own activation, and an activated build keeps mutating its own write", async (t) => {
  const defaultDir = await initializedFormat2Directory(t, "1667-settings-successor-write-default-");
  const defaultStore = new SettingsV2Store(defaultDir, { now: () => FIXED_TIME });
  await defaultStore.init();
  await defaultStore.save(saveCommand(MUTATION_A, 1, writingDocument("Default write reaches schema 3.")));

  const firstRaw = await readRawState(defaultDir);
  assert.equal(firstRaw.schemaVersion, 3);
  assert.equal(
    activeModelCapabilities(firstRaw).imageInput,
    "unsupported",
    "the dry-run model gets the migration's fixed imageInput value"
  );

  // A second save against the same directory, no restart and no forced
  // option: still schema 3, because this release owns writing schema 3
  // going forward once activated, not only for a single proof write. The
  // dry-run model's imageInput carries forward rather than resetting.
  await defaultStore.save(saveCommand(MUTATION_B, 2, writingDocument("Second write stays schema 3.")));
  const secondRaw = await readRawState(defaultDir);
  assert.equal(secondRaw.schemaVersion, 3);
  assert.equal(activeModelCapabilities(secondRaw).imageInput, "unsupported");
  assert.equal(
    (await defaultStore.loadView()).effective.systemPrompt,
    "Second write stays schema 3."
  );

  // A store that explicitly resolves activation false, a genuine
  // predecessor, always stays schema 2, even in this build.
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
