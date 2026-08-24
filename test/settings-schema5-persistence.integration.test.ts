import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { SETTINGS_STATE_V2_FILE, SETTINGS_STATE_V2_NEXT_FILE } from "../server/data-directory-layout.js";
import { formatSettingsStateV2, parseSettingsStateV2 } from "../server/settings-v2-codec.js";
import { INITIAL_SETTINGS_DOCUMENT_V2, INITIAL_SETTINGS_STATE_V2 } from "../server/settings-v2-default.js";
import { formatSettingsStateV3, parseSettingsStateV3 } from "../server/settings-v3-codec.js";
import { INITIAL_SETTINGS_STATE_V3 } from "../server/settings-v3-default.js";
import {
  formatSettingsStateV4,
  hashSettingsDocumentV4,
  parseSettingsDocumentV4,
  parseSettingsStateV4
} from "../server/settings-v4-codec.js";
import { INITIAL_SETTINGS_STATE_V4 } from "../server/settings-v4-default.js";
import { INITIAL_SETTINGS_DOCUMENT_V4 } from "../server/settings-v4-default.js";
import { convertSettingsDocumentV2ToV3 } from "../server/settings-v3-conversion.js";
import { formatSettingsStateV5, parseSettingsDocumentV5, parseSettingsStateV5 } from "../server/settings-v5-codec.js";
import {
  convertSettingsDocumentV2ToV5,
  convertSettingsDocumentV3ToV5,
  convertSettingsDocumentV4ToV5
} from "../server/settings-v5-conversion.js";
import { INITIAL_SETTINGS_DOCUMENT_V5, INITIAL_SETTINGS_STATE_V5 } from "../server/settings-v5-default.js";
import { SettingsStore } from "../server/settings.js";
import { MutationLedgerStore } from "../server/mutation-ledger-store.js";
import { SettingsV2Store } from "../server/settings-v2-store.js";
import {
  hashSettingsSchema5UpgradePrepared,
  readSettingsSchema5UpgradeCompleted,
  readSettingsSchema5UpgradePrepared
} from "../server/settings-schema5-upgrade.js";
import { readProviderSecrets, writeProviderSecret } from "../server/provider-secret-store.js";
import {
  SETTINGS_PENDING_SECRETS_FILE
} from "../server/settings-pending-secrets.js";
import {
  MAX_SETTINGS_SAVE_REQUEST_BYTES,
  MAX_WRITING_OBJECT_BYTES
} from "../shared/settings-v5-limits.js";
import { DEFAULT_CONTINUE_DIRECTION, DEFAULT_WRITING_PROMPT_SETTINGS } from "../shared/settings-v5-writing.js";
import { validateWorkerRequestSize } from "../server/worker-request-size.js";
import { WORKER_PROTOCOL_VERSION } from "../shared/worker-protocol.js";
import {
  FIXED_TIME,
  MUTATION_A,
  MUTATION_B,
  MUTATION_C,
  hasServiceCode,
  initializedFormat2Directory,
  preparedFixture,
  saveCommand
} from "./settings-store-fixtures.js";

function statePath(dataDir: string): string {
  return path.join(dataDir, SETTINGS_STATE_V2_FILE);
}

function nextPath(dataDir: string): string {
  return path.join(dataDir, SETTINGS_STATE_V2_NEXT_FILE);
}

const CUSTOM_WRITING = Object.freeze({
  defaultAuthorBrief: "Brief one.",
  defaultContinueDirection: "Keep walking.",
  rewriteGuidance: "Tighten verbs.",
  titleGuidance: "Name the river.",
  summaryGuidance: "Cover the crossing.",
  asideGuidance: "Stay in the room."
});

test("first save from schema 2, 3, and 4 publishes schema 5 and keeps conversion writing", async (t) => {
  for (const [label, plant] of [
    ["schema-2", async (dataDir: string) => {
      /* initial format-2 directory already holds schema 2 */
      void dataDir;
    }],
    ["schema-3", async (dataDir: string) => {
      await writeFile(statePath(dataDir), formatSettingsStateV3(INITIAL_SETTINGS_STATE_V3), { mode: 0o600 });
    }],
    ["schema-4", async (dataDir: string) => {
      await writeFile(statePath(dataDir), formatSettingsStateV4(INITIAL_SETTINGS_STATE_V4), { mode: 0o600 });
    }]
  ] as const) {
    await t.test(label, async (sub) => {
      const dataDir = await initializedFormat2Directory(sub, `1667-schema5-first-save-${label}-`);
      await plant(dataDir);
      const store = new SettingsStore(dataDir, { now: () => FIXED_TIME });
      await store.init(2);
      const view = await store.loadView();
      assert.equal(view.editable, true);
      assert.equal(view.document?.schemaVersion, 5);
      assert.equal(view.activeWriting.defaultContinueDirection, DEFAULT_CONTINUE_DIRECTION);
      assert.ok(view.document);
      await store.save(saveCommand(MUTATION_A, view.stateGeneration!, view.document));
      const published = parseSettingsStateV5(JSON.parse(await readFile(statePath(dataDir), "utf8")));
      assert.equal(published.schemaVersion, 5);
      const active = published.documents[String(published.activeRevision)]!;
      assert.equal(active.writing.defaultContinueDirection, DEFAULT_CONTINUE_DIRECTION);
      assert.equal(active.writing.rewriteGuidance, "");
    });
  }
});

test("schema-5 upgrade completion binds the exact prepared record", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-schema5-upgrade-receipt-hash-");
  let clock = 0;
  const ledger = new MutationLedgerStore(dataDir);
  const store = new SettingsV2Store(dataDir, {
    ledger,
    now: () => new Date(FIXED_TIME.getTime() + clock++),
    validateCandidate: async () => true
  });
  await store.init();
  const view = await store.loadView();
  assert.ok(view.document);
  await store.save(saveCommand(MUTATION_A, view.stateGeneration!, view.document));

  const prepared = await readSettingsSchema5UpgradePrepared(dataDir);
  const completed = await readSettingsSchema5UpgradeCompleted(dataDir);
  assert.ok(prepared);
  assert.ok(completed);
  assert.equal(
    completed.preparedRecordHash,
    hashSettingsSchema5UpgradePrepared(prepared),
    "completion must hash the record that was written, not a re-derived timestamp"
  );
  const restarted = new SettingsV2Store(dataDir, { now: () => FIXED_TIME, validateCandidate: async () => true });
  await restarted.init();
  assert.equal(await readSettingsSchema5UpgradePrepared(dataDir), null);
  assert.equal(await readSettingsSchema5UpgradeCompleted(dataDir), null);
});

test("a schema-4 mid-activation state recovers on save without startup writes", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-schema4-mid-activation-save-");
  const active = INITIAL_SETTINGS_DOCUMENT_V4;
  const candidate = parseSettingsDocumentV4({
    ...active,
    writing: { ...active.writing, defaultAuthorBrief: "A recovered candidate." }
  });
  const state = parseSettingsStateV4({
    ...INITIAL_SETTINGS_STATE_V4,
    stateGeneration: 2,
    settingsRevisionClock: 2,
    documents: { "1": active, "2": candidate },
    activeRevision: 1,
    pendingRevision: 2,
    previousRevision: null,
    activation: {
      transactionId: MUTATION_A,
      oldHash: hashSettingsDocumentV4(active),
      candidateHash: hashSettingsDocumentV4(candidate),
      state: "validating",
      attempt: 1
    },
    lastActivationOutcome: null,
    lastTransaction: { receiptKind: "user", mutationId: MUTATION_A, phase: "prepared" }
  });
  await writeFile(statePath(dataDir), formatSettingsStateV4(state), { mode: 0o600 });
  const before = await readFile(statePath(dataDir));
  const store = new SettingsV2Store(dataDir, {
    now: () => FIXED_TIME,
    validateCandidate: async () => true
  });
  await store.init();
  assert.deepEqual(await readFile(statePath(dataDir)), before, "startup keeps source activation read-only");
  const view = await store.loadView();
  assert.equal(view.editable, true);
  await store.save(saveCommand(MUTATION_B, view.stateGeneration!, {
    ...view.document!,
    writing: { ...view.document!.writing, defaultAuthorBrief: "Saved after recovery." }
  }));
  assert.equal(JSON.parse(await readFile(statePath(dataDir), "utf8")).schemaVersion, 5);
  assert.equal((await store.loadView()).activeWriting.defaultAuthorBrief, "Saved after recovery.");
});

test("a staged legacy candidate can be replaced by its active document during schema-5 upgrade", async (t) => {
  for (const schema of ["schema2", "schema3", "schema4"] as const) {
    await t.test(schema, async (sub) => {
      const dataDir = await initializedFormat2Directory(sub, `1667-schema5-discard-staged-${schema}-`);
      await writeStagedLegacyState(dataDir, schema);
      const store = new SettingsV2Store(dataDir, {
        environment: {},
        now: () => FIXED_TIME
      });
      await store.init();

      const before = await store.loadView();
      assert.equal(before.activeRevision, 1);
      assert.equal(before.pendingRevision, 2);
      if (schema === "schema2") {
        assert.deepEqual(before.lastActivationOutcome, {
          transactionId: MUTATION_A,
          candidateRevision: 2,
          result: "validation-failed",
          errorCode: "credential_unresolved",
          atStateGeneration: 4
        });
      }
      assert.ok(before.document);

      const activeDocument = activeDocumentForSchema(schema);
      const saved = await store.save(saveCommand(MUTATION_B, before.stateGeneration!, activeDocument));
      assert.equal(saved.pendingSettingsRevision, null);
      assert.equal(saved.activeSettingsRevision, 1);
      assert.equal(saved.activationOutcome, null);

      const published = parseSettingsStateV5(JSON.parse(await readFile(statePath(dataDir), "utf8")));
      assert.equal(published.schemaVersion, 5);
      assert.equal(published.activeRevision, 1);
      assert.equal(published.pendingRevision, null);
      assert.equal(published.lastActivationOutcome, null);
      const after = await store.loadView();
      assert.equal(after.activeRevision, 1);
      assert.equal(after.pendingRevision, null);
      assert.equal(after.lastActivationOutcome, null);
      assert.equal(after.effective.provider, "dry-run");
    });
  }
});

async function writeStagedLegacyState(
  dataDir: string,
  schema: "schema2" | "schema3" | "schema4"
): Promise<void> {
  const environmentName = `AI_1667_LEGACY_${schema.toUpperCase()}_KEY`;
  const pointer = { receiptKind: "user" as const, mutationId: MUTATION_A, phase: "prepared" as const };
  if (schema === "schema2") {
    const active = INITIAL_SETTINGS_DOCUMENT_V2;
    const state = parseSettingsStateV2({
      ...INITIAL_SETTINGS_STATE_V2,
      stateGeneration: 2,
      settingsRevisionClock: 2,
      documents: { "1": active, "2": convertSettingsDocumentV2ForFixture(environmentName) },
      activeRevision: 1,
      pendingRevision: 2,
      previousRevision: null,
      activation: null,
      lastActivationOutcome: null,
      lastTransaction: pointer
    });
    await writeFile(statePath(dataDir), formatSettingsStateV2(state), { mode: 0o600 });
    const ledger = new MutationLedgerStore(dataDir);
    await ledger.init();
    await ledger.writeUserRecord(preparedFixture(MUTATION_A, INITIAL_SETTINGS_STATE_V2, state));
    return;
  }
  if (schema === "schema3") {
    const active = convertSettingsDocumentV2ToV3(INITIAL_SETTINGS_DOCUMENT_V2);
    const candidate = convertSettingsDocumentV2ToV3(convertSettingsDocumentV2ForFixture(environmentName));
    await writeFile(statePath(dataDir), formatSettingsStateV3(parseSettingsStateV3({
      ...INITIAL_SETTINGS_STATE_V3,
      stateGeneration: 2,
      settingsRevisionClock: 2,
      documents: { "1": active, "2": candidate },
      activeRevision: 1,
      pendingRevision: 2,
      previousRevision: null,
      activation: null,
      lastActivationOutcome: null,
      lastTransaction: pointer
    })), { mode: 0o600 });
    return;
  }
  const active = INITIAL_SETTINGS_DOCUMENT_V4;
  const candidate = parseSettingsDocumentV4({
    ...active,
    connections: {
      ...active.connections,
      "builtin:dry-run": {
        ...active.connections["builtin:dry-run"]!,
        preset: "openai",
        protocol: "openai-chat-completions",
        baseUrl: "https://api.openai.com/v1",
        auth: { type: "bearer-env", env: environmentName }
      }
    }
  });
  await writeFile(statePath(dataDir), formatSettingsStateV4(parseSettingsStateV4({
    ...INITIAL_SETTINGS_STATE_V4,
    stateGeneration: 2,
    settingsRevisionClock: 2,
    documents: { "1": active, "2": candidate },
    activeRevision: 1,
    pendingRevision: 2,
    previousRevision: null,
    activation: null,
    lastActivationOutcome: null,
    lastTransaction: pointer
  })), { mode: 0o600 });
}

function activeDocumentForSchema(schema: "schema2" | "schema3" | "schema4") {
  if (schema === "schema2") return convertSettingsDocumentV2ToV5(INITIAL_SETTINGS_DOCUMENT_V2);
  if (schema === "schema3") {
    return convertSettingsDocumentV3ToV5(convertSettingsDocumentV2ToV3(INITIAL_SETTINGS_DOCUMENT_V2));
  }
  return convertSettingsDocumentV4ToV5(INITIAL_SETTINGS_DOCUMENT_V4);
}

function convertSettingsDocumentV2ForFixture(environmentName: string) {
  return {
    ...INITIAL_SETTINGS_DOCUMENT_V2,
    connections: {
      ...INITIAL_SETTINGS_DOCUMENT_V2.connections,
      "builtin:dry-run": {
        ...INITIAL_SETTINGS_DOCUMENT_V2.connections["builtin:dry-run"]!,
        preset: "openai" as const,
        protocol: "openai-chat-completions" as const,
        baseUrl: "https://api.openai.com/v1",
        auth: { type: "bearer-env" as const, env: environmentName }
      }
    }
  };
}

test("unrelated settings saves keep the complete writing object", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-schema5-writing-preserve-");
  const store = new SettingsStore(dataDir, { now: () => FIXED_TIME, validateCandidate: async () => true });
  await store.init(2);
  const first = await store.loadView();
  assert.ok(first.document);
  const withWriting = parseSettingsDocumentV5({
    ...first.document,
    writing: CUSTOM_WRITING
  });
  await store.save(saveCommand(MUTATION_A, first.stateGeneration!, withWriting));
  const afterWriting = await store.loadView();
  assert.ok(afterWriting.document);
  const rerouted = parseSettingsDocumentV5({
    ...afterWriting.document,
    routing: { ...afterWriting.document.routing, utility: afterWriting.document.routing.default }
  });
  await store.save(saveCommand(MUTATION_B, afterWriting.stateGeneration!, rerouted));
  const restarted = new SettingsStore(dataDir, { now: () => FIXED_TIME });
  await restarted.init(2);
  const view = await restarted.loadView();
  assert.deepEqual(view.document?.writing, CUSTOM_WRITING);
  assert.deepEqual(view.activeWriting, CUSTOM_WRITING);
});

test("schema 5 .next without a matching receipt refuses without changing current", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-schema5-unmatched-next-");
  const currentBytes = await readFile(statePath(dataDir));
  await writeFile(
    nextPath(dataDir),
    formatSettingsStateV5({
      ...INITIAL_SETTINGS_STATE_V5,
      lastTransaction: { receiptKind: "user", mutationId: MUTATION_A, phase: "prepared" }
    }),
    { mode: 0o600 }
  );
  const store = new SettingsStore(dataDir, { now: () => FIXED_TIME });
  await assert.rejects(store.init(2), hasServiceCode("mutation_outcome_unknown"));
  assert.deepEqual(await readFile(statePath(dataDir)), currentBytes);
});

test("older schema-2 parser refuses schema 5 instead of downgrading it", () => {
  assert.throws(
    () => parseSettingsStateV2({
      ...INITIAL_SETTINGS_STATE_V2,
      schemaVersion: 5,
      documents: { "1": INITIAL_SETTINGS_DOCUMENT_V5 }
    }),
    /schemaVersion/u
  );
});

test("new minted secrets use pending ownership and survive shared-tier neighbors", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-schema5-pending-secret-");
  const secretsDir = await initializedFormat2Directory(t, "1667-schema5-shared-tier-");
  await writeProviderSecret(secretsDir, "neighbor.k00000000-0000-4000-8000-0000000000aa", "sk-neighbor");
  const mintedId = "demo.k00000000-0000-4000-8000-0000000000b1";
  const store = new SettingsStore(dataDir, {
    now: () => FIXED_TIME,
    secretsDir,
    validateCandidate: async () => true
  });
  await store.init(2);
  const view = await store.loadView();
  assert.ok(view.document);
  const document = convertSettingsDocumentV2ToV5({
    ...INITIAL_SETTINGS_DOCUMENT_V2,
    connections: {
      ...INITIAL_SETTINGS_DOCUMENT_V2.connections,
      "builtin:dry-run": {
        ...INITIAL_SETTINGS_DOCUMENT_V2.connections["builtin:dry-run"]!,
        preset: "openai",
        protocol: "openai-chat-completions",
        baseUrl: "https://api.openai.com/v1",
        auth: { type: "bearer-stored", secretId: mintedId }
      }
    }
  });
  await store.save({
    ...saveCommand(MUTATION_A, view.stateGeneration!, document),
    connectionSecrets: { [mintedId]: "sk-owned" }
  });
  const secrets = await readProviderSecrets(secretsDir);
  assert.equal(secrets.get(mintedId), "sk-owned");
  assert.equal(secrets.get("neighbor.k00000000-0000-4000-8000-0000000000aa"), "sk-neighbor");
  await assert.rejects(
    readFile(path.join(dataDir, SETTINGS_PENDING_SECRETS_FILE)),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT"
  );
});

test("crash after ownership and before secret write deletes only owned minted IDs", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-schema5-crash-ownership-");
  const secretsDir = await initializedFormat2Directory(t, "1667-schema5-crash-tier-");
  await writeProviderSecret(secretsDir, "live.k00000000-0000-4000-8000-00000000cc", "sk-live");
  const mintedId = "demo.k00000000-0000-4000-8000-0000000000d1";
  const store = new SettingsV2Store(dataDir, {
    now: () => FIXED_TIME,
    secretsDir,
    validateCandidate: async () => true,
    saveHooks: {
      afterPendingSecretsOwnership: () => {
        throw new Error("injected crash after ownership");
      }
    }
  });
  await store.init();
  const view = await store.loadView();
  assert.ok(view.document);
  const document = convertSettingsDocumentV2ToV5({
    ...INITIAL_SETTINGS_DOCUMENT_V2,
    connections: {
      ...INITIAL_SETTINGS_DOCUMENT_V2.connections,
      "builtin:dry-run": {
        ...INITIAL_SETTINGS_DOCUMENT_V2.connections["builtin:dry-run"]!,
        preset: "openai",
        protocol: "openai-chat-completions",
        baseUrl: "https://api.openai.com/v1",
        auth: { type: "bearer-stored", secretId: mintedId }
      }
    }
  });
  await assert.rejects(
    store.save({
      ...saveCommand(MUTATION_A, view.stateGeneration, document),
      connectionSecrets: { [mintedId]: "sk-new" }
    }),
    /injected crash after ownership/u
  );
  const recovered = new SettingsV2Store(dataDir, {
    now: () => FIXED_TIME,
    secretsDir,
    validateCandidate: async () => true
  });
  await recovered.init();
  const secrets = await readProviderSecrets(secretsDir);
  assert.equal(secrets.has(mintedId), false);
  assert.equal(secrets.get("live.k00000000-0000-4000-8000-00000000cc"), "sk-live");
  const current = JSON.parse(await readFile(statePath(dataDir), "utf8")) as { schemaVersion: number };
  assert.equal(current.schemaVersion, 2);
});

test("rotating and removing minted secrets keeps unrelated live secrets", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-schema5-rotate-remove-");
  const firstId = "demo.k00000000-0000-4000-8000-0000000000a1";
  const rotatedId = "demo.k00000000-0000-4000-8000-0000000000a2";
  const store = new SettingsStore(dataDir, {
    now: () => FIXED_TIME,
    validateCandidate: async () => true
  });
  await store.init(2);
  const view = await store.loadView();
  assert.ok(view.document);
  const withFirst = convertSettingsDocumentV2ToV5({
    ...INITIAL_SETTINGS_DOCUMENT_V2,
    connections: {
      ...INITIAL_SETTINGS_DOCUMENT_V2.connections,
      "builtin:dry-run": {
        ...INITIAL_SETTINGS_DOCUMENT_V2.connections["builtin:dry-run"]!,
        preset: "openai",
        protocol: "openai-chat-completions",
        baseUrl: "https://api.openai.com/v1",
        auth: { type: "bearer-stored", secretId: firstId }
      }
    }
  });
  await store.save({
    ...saveCommand(MUTATION_A, view.stateGeneration!, withFirst),
    connectionSecrets: { [firstId]: "sk-first" }
  });
  const afterFirst = await store.loadView();
  assert.ok(afterFirst.document);
  const withRotated = parseSettingsDocumentV5({
    ...afterFirst.document,
    connections: {
      ...afterFirst.document.connections,
      "builtin:dry-run": {
        ...afterFirst.document.connections["builtin:dry-run"]!,
        auth: { type: "bearer-stored", secretId: rotatedId }
      }
    }
  });
  await store.save({
    ...saveCommand(MUTATION_B, afterFirst.stateGeneration!, withRotated),
    connectionSecrets: { [rotatedId]: "sk-rotated" }
  });
  assert.equal((await readProviderSecrets(dataDir)).get(rotatedId), "sk-rotated");
  assert.equal((await readProviderSecrets(dataDir)).has(firstId), false);
  const afterRotate = await store.loadView();
  assert.ok(afterRotate.document);
  const dryRun = convertSettingsDocumentV2ToV5(INITIAL_SETTINGS_DOCUMENT_V2);
  await store.save({
    ...saveCommand(MUTATION_C, afterRotate.stateGeneration!, dryRun),
    connectionSecrets: { [rotatedId]: null }
  });
  assert.equal((await readProviderSecrets(dataDir)).has(rotatedId), false);
});

test("save request over 8 MiB is refused on the worker transport", () => {
  const oversized = "x".repeat(MAX_SETTINGS_SAVE_REQUEST_BYTES + 1);
  assert.throws(
    () => validateWorkerRequestSize(
      "saveSettings",
      {
        command: {
          transportOperationId: "op",
          mutationId: MUTATION_A,
          expectedStateGeneration: 1,
          document: INITIAL_SETTINGS_DOCUMENT_V5,
          connectionSecrets: { "demo.k00000000-0000-4000-8000-0000000000e1": oversized }
        }
      },
      WORKER_PROTOCOL_VERSION
    ),
    (error: unknown) => error instanceof Error && /too large/u.test(error.message)
  );
});

test("control-heavy writing that expands past the canonical JSON budget is refused", () => {
  const controlHeavy = "\u0001".repeat(65_536);
  assert.throws(
    () => parseSettingsDocumentV5({
      ...INITIAL_SETTINGS_DOCUMENT_V5,
      writing: {
        ...DEFAULT_WRITING_PROMPT_SETTINGS,
        rewriteGuidance: controlHeavy
      }
    }),
    new RegExp(String(MAX_WRITING_OBJECT_BYTES), "u")
  );
});
