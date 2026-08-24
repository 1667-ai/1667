import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { SETTINGS_STATE_V2_FILE } from "../server/data-directory-layout.js";
import { convertSettingsDocumentV2ToV5 } from "../server/settings-v5-conversion.js";
import { INITIAL_SETTINGS_DOCUMENT_V2 } from "../server/settings-v2-default.js";
import { formatSettingsStateV3 } from "../server/settings-v3-codec.js";
import { INITIAL_SETTINGS_STATE_V3 } from "../server/settings-v3-default.js";
import { formatSettingsStateV4 } from "../server/settings-v4-codec.js";
import { INITIAL_SETTINGS_STATE_V4 } from "../server/settings-v4-default.js";
import { SettingsV2Store } from "../server/settings-v2-store.js";
import { readProviderSecrets, writeProviderSecret } from "../server/provider-secret-store.js";
import {
  SETTINGS_SAVE_CRASH_HOOK_NAMES,
  type SettingsSaveCrashHookName
} from "../server/settings-save-hooks.js";
import { SETTINGS_PENDING_SECRETS_FILE } from "../server/settings-pending-secrets.js";
import { parseSettingsStateV5 } from "../server/settings-v5-codec.js";
import {
  FIXED_TIME,
  MUTATION_A,
  MUTATION_B,
  MUTATION_C,
  initializedFormat2Directory,
  saveCommand,
  writingDocument
} from "./settings-store-fixtures.js";
import {
  readSettingsSchema5UpgradeCompleted,
  readSettingsSchema5UpgradePrepared
} from "../server/settings-schema5-upgrade.js";

function statePath(dataDir: string): string {
  return path.join(dataDir, SETTINGS_STATE_V2_FILE);
}

function credentialDocument(secretId: string) {
  return convertSettingsDocumentV2ToV5({
    ...INITIAL_SETTINGS_DOCUMENT_V2,
    connections: {
      ...INITIAL_SETTINGS_DOCUMENT_V2.connections,
      "builtin:dry-run": {
        ...INITIAL_SETTINGS_DOCUMENT_V2.connections["builtin:dry-run"]!,
        preset: "openai",
        protocol: "openai-chat-completions",
        baseUrl: "https://api.openai.com/v1",
        auth: { type: "bearer-stored", secretId }
      }
    }
  });
}

async function publishSchema5(dataDir: string): Promise<void> {
  const store = new SettingsV2Store(dataDir, {
    now: () => FIXED_TIME,
    validateCandidate: async () => true
  });
  await store.init();
  const view = await store.loadView();
  assert.ok(view.document);
  await store.save(saveCommand(MUTATION_A, view.stateGeneration, view.document));
}

test("schema-5 save crash cuts recover without losing the source or published state", {
  timeout: 60_000
}, async (t) => {
  for (const hookName of SETTINGS_SAVE_CRASH_HOOK_NAMES) {
    await t.test(`schema-2 source ${hookName}`, async (sub) => {
      await recoverCut(sub, hookName, "schema2");
    });
    await t.test(`schema-3 source ${hookName}`, async (sub) => {
      await recoverCut(sub, hookName, "schema3");
    });
    await t.test(`schema-4 source ${hookName}`, async (sub) => {
      await recoverCut(sub, hookName, "schema4");
    });
    await t.test(`ordinary schema-5 ${hookName}`, async (sub) => {
      await recoverCut(sub, hookName, "schema5");
    });
  }
});

async function recoverCut(
  t: test.TestContext,
  hookName: SettingsSaveCrashHookName,
  mode: "schema2" | "schema3" | "schema4" | "schema5"
): Promise<void> {
  const dataDir = await initializedFormat2Directory(t, `1667-schema5-cut-${mode}-${hookName}-`);
  const secretsDir = await initializedFormat2Directory(t, `1667-schema5-cut-tier-${mode}-${hookName}-`);
  const neighborId = "neighbor.k00000000-0000-4000-8000-0000000000f0";
  await writeProviderSecret(secretsDir, neighborId, "sk-neighbor");
  if (mode === "schema3") {
    await writeFile(statePath(dataDir), formatSettingsStateV3(INITIAL_SETTINGS_STATE_V3), { mode: 0o600 });
  } else if (mode === "schema4") {
    await writeFile(statePath(dataDir), formatSettingsStateV4(INITIAL_SETTINGS_STATE_V4), { mode: 0o600 });
  } else if (mode === "schema5") await publishSchema5(dataDir);
  const mintedId = "demo.k00000000-0000-4000-8000-0000000000f1";
  const crashing = new SettingsV2Store(dataDir, {
    secretsDir,
    now: () => FIXED_TIME,
    validateCandidate: async () => true,
    saveHooks: {
      [hookName]: () => {
        throw new Error(`injected crash at ${hookName}`);
      }
    }
  });
  await crashing.init();
  const view = await crashing.loadView();
  assert.ok(view.document);
  const before = await readFile(statePath(dataDir));
  await assert.rejects(
    crashing.save({
      ...saveCommand(MUTATION_B, view.stateGeneration, credentialDocument(mintedId)),
      connectionSecrets: { [mintedId]: "sk-cut" }
    }),
    new RegExp(`injected crash at ${hookName}`, "u")
  );
  const recovered = new SettingsV2Store(dataDir, {
    secretsDir,
    now: () => FIXED_TIME,
    validateCandidate: async () => true
  });
  await recovered.init();
  const after = JSON.parse(await readFile(statePath(dataDir), "utf8")) as { schemaVersion: number };
  if (
    hookName === "afterNextStaged"
    || hookName === "afterCurrentPublished"
    || hookName === "afterReceiptCompleted"
    || hookName === "afterSecretCleanup"
  ) {
    assert.equal(after.schemaVersion, 5);
    parseSettingsStateV5(after);
  } else if (mode !== "schema5") {
    assert.deepEqual(await readFile(statePath(dataDir)), before);
  } else {
    assert.equal(after.schemaVersion, 5);
  }
  const secrets = await readProviderSecrets(secretsDir);
  assert.equal(secrets.get(neighborId), "sk-neighbor");
  const sourceAuthoritative = hookName === "afterPendingSecretsOwnership"
    || hookName === "afterSecretValueWrite"
    || hookName === "afterReceiptPrepared";
  if (sourceAuthoritative) {
    assert.equal(secrets.has(mintedId), false);
  } else {
    assert.equal(secrets.get(mintedId), "sk-cut");
  }
  await assert.rejects(
    readFile(path.join(dataDir, SETTINGS_PENDING_SECRETS_FILE)),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT"
  );
  if (sourceAuthoritative || after.schemaVersion !== 5) {
    const retry = await recovered.loadView();
    assert.ok(retry.document);
    await recovered.save({
      ...saveCommand(MUTATION_C, retry.stateGeneration, credentialDocument(mintedId)),
      connectionSecrets: { [mintedId]: "sk-cut" }
    });
  }
  const published = parseSettingsStateV5(JSON.parse(await readFile(statePath(dataDir), "utf8")));
  assert.equal(published.schemaVersion, 5);
  if (mode === "schema5" && hookName === "afterSecretCleanup") {
    const secondId = "demo.k00000000-0000-4000-8000-0000000000f2";
    const retry = await recovered.loadView();
    assert.ok(retry.document);
    await recovered.save({
      ...saveCommand(MUTATION_C, retry.stateGeneration, credentialDocument(secondId)),
      connectionSecrets: { [secondId]: "sk-second" }
    });
    const afterSecond = await readProviderSecrets(secretsDir);
    assert.equal(afterSecond.get(secondId), "sk-second");
    assert.equal(afterSecond.has(mintedId), false);
  }
}

test("schema 2, 3, and 4 upgrades recover every no-secret crash cut", {
  timeout: 60_000
}, async (t) => {
  for (const hookName of SETTINGS_SAVE_CRASH_HOOK_NAMES) {
    for (const mode of ["schema2", "schema3", "schema4"] as const) {
      await t.test(`${mode} ${hookName}`, async (sub) => {
        const dataDir = await initializedFormat2Directory(sub, `1667-schema5-no-secret-${mode}-${hookName}-`);
        if (mode === "schema3") {
          await writeFile(statePath(dataDir), formatSettingsStateV3(INITIAL_SETTINGS_STATE_V3), { mode: 0o600 });
        } else if (mode === "schema4") {
          await writeFile(statePath(dataDir), formatSettingsStateV4(INITIAL_SETTINGS_STATE_V4), { mode: 0o600 });
        }
        const crashing = new SettingsV2Store(dataDir, {
          now: () => FIXED_TIME,
          validateCandidate: async () => true,
          saveHooks: {
            [hookName]: () => {
              throw new Error(`injected crash at ${hookName}`);
            }
          }
        });
        await crashing.init();
        const view = await crashing.loadView();
        assert.ok(view.document);
        const before = await readFile(statePath(dataDir));
        await assert.rejects(
          crashing.save(saveCommand(MUTATION_B, view.stateGeneration!, writingDocument("No new secret."))),
          new RegExp(`injected crash at ${hookName}`, "u")
        );

        const recovered = new SettingsV2Store(dataDir, {
          now: () => FIXED_TIME,
          validateCandidate: async () => true
        });
        await recovered.init();
        assert.equal(await readSettingsSchema5UpgradePrepared(dataDir), null);
        assert.equal(await readSettingsSchema5UpgradeCompleted(dataDir), null);
        const sourceAuthoritative = hookName === "afterPendingSecretsOwnership"
          || hookName === "afterSecretValueWrite"
          || hookName === "afterReceiptPrepared";
        if (sourceAuthoritative) {
          assert.deepEqual(await readFile(statePath(dataDir)), before);
          const retry = await recovered.loadView();
          assert.ok(retry.document);
          await recovered.save(saveCommand(MUTATION_C, retry.stateGeneration!, writingDocument("Retry without a secret.")));
        } else {
          assert.equal(
            JSON.parse(await readFile(statePath(dataDir), "utf8")).schemaVersion,
            5
          );
        }
        assert.equal(
          JSON.parse(await readFile(statePath(dataDir), "utf8")).schemaVersion,
          5
        );
        if (sourceAuthoritative) {
          assert.equal(await recovered.inspectMutationReceipt(MUTATION_B), null);
        }
      });
    }
  }
});
