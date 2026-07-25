import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  PROVIDER_SECRETS_NEXT_FILE,
  SETTINGS_STATE_V2_NEXT_FILE
} from "../server/data-directory-layout.js";
import {
  deleteProviderSecret,
  pruneProviderSecrets,
  readProviderSecrets,
  writeProviderSecret
} from "../server/provider-secret-store.js";
import { resolveProviderHeaders } from "../server/provider-runtime.js";
import { SettingsStore } from "../server/settings.js";
import { readSettingsState } from "../server/settings-state-file.js";
import { settingsMutationFingerprint } from "../server/settings-v2-mutation.js";
import type { SettingsDocumentV2 } from "../shared/settings-v2-types.js";
import {
  FIXED_TIME,
  MUTATION_A,
  MUTATION_B,
  credentialedDocument,
  initializedFormat2Directory,
  saveCommand,
  transactionBytes
} from "./settings-store-fixtures.js";

const STORED_SECRET = "sk-stored-fixture-value";

test("provider secret store publishes mode 0600 and prunes unreferenced IDs", async (t) => {
  const dataDir = await initializedFormat2Directory(
    t,
    "1667-provider-secrets-"
  );
  await writeProviderSecret(dataDir, "connection:one", "first-secret");
  await writeProviderSecret(dataDir, "connection:two", "second-secret");

  assert.deepEqual(
    [...(await readProviderSecrets(dataDir)).entries()].sort(),
    [
      ["connection:one", "first-secret"],
      ["connection:two", "second-secret"]
    ]
  );
  if (process.platform !== "win32") {
    assert.equal((await stat(path.join(dataDir, "secrets.json"))).mode & 0o777, 0o600);
  }

  await pruneProviderSecrets(dataDir, ["connection:two"]);
  assert.deepEqual(
    [...(await readProviderSecrets(dataDir)).entries()],
    [["connection:two", "second-secret"]]
  );
  await deleteProviderSecret(dataDir, "connection:two");
  assert.deepEqual(await readProviderSecrets(dataDir), new Map());
});

test("settings init removes provider secrets scratch residue", async (t) => {
  const dataDir = await initializedFormat2Directory(
    t,
    "1667-provider-secrets-scratch-"
  );
  const scratch = path.join(dataDir, PROVIDER_SECRETS_NEXT_FILE);
  await writeFile(scratch, `{"orphan":"${STORED_SECRET}"}`, { mode: 0o600 });

  const store = new SettingsStore(dataDir, { now: () => FIXED_TIME });
  await store.init(2);

  await assert.rejects(
    stat(scratch),
    (error) => error instanceof Error
      && "code" in error
      && error.code === "ENOENT"
  );
});

test("settings sidecar stays out of state and ledger, then activates stored auth", async (t) => {
  const dataDir = await initializedFormat2Directory(
    t,
    "1667-stored-activation-"
  );
  const secretId = "builtin:dry-run";
  const document = storedDocument(secretId);
  assert.equal(
    settingsMutationFingerprint({
      method: "saveSettings",
      document,
      connectionSecrets: { [secretId]: STORED_SECRET }
    }, 1),
    settingsMutationFingerprint({ method: "saveSettings", document }, 1)
  );
  const first = new SettingsStore(dataDir, {
    environment: {},
    now: () => FIXED_TIME
  });
  await first.init(2);
  await first.save({
    ...saveCommand(MUTATION_A, 1, document),
    connectionSecrets: { [secretId]: STORED_SECRET }
  });

  assert.equal(
    (await readProviderSecrets(dataDir)).get(secretId),
    STORED_SECRET
  );
  for (const bytes of await transactionBytes(dataDir, MUTATION_A)) {
    assert.equal(bytes.includes(STORED_SECRET), false);
  }
  assert.equal(
    (await readFile(path.join(dataDir, "settings.v2.state.json"), "utf8"))
      .includes(STORED_SECRET),
    false
  );

  const restarted = new SettingsStore(dataDir, {
    environment: {},
    now: () => FIXED_TIME,
    validateCandidate: async (settings) => {
      const resolved = resolveProviderHeaders(settings, {});
      assert.equal(
        resolved.headers.authorization,
        `Bearer ${STORED_SECRET}`
      );
      assert.deepEqual(resolved.secrets, [STORED_SECRET]);
      return true;
    }
  });
  await restarted.init(2);

  const view = await restarted.loadView();
  if (!view.editable) throw new Error("format-2 view must be editable");
  assert.equal(view.activeRevision, 2);
  assert.equal(view.pendingRevision, null);
  assert.equal(view.effective.apiKeyEnv, null);
  assert.deepEqual(
    view.document.connections[secretId]?.auth,
    { type: "bearer-stored", secretId }
  );
});

test("missing stored auth fails activation as credential_unresolved", async (t) => {
  const dataDir = await initializedFormat2Directory(
    t,
    "1667-missing-stored-"
  );
  const secretId = "builtin:dry-run";
  const first = new SettingsStore(dataDir, {
    environment: {},
    now: () => FIXED_TIME
  });
  await first.init(2);
  await first.save(saveCommand(MUTATION_A, 1, storedDocument(secretId)));

  const restarted = new SettingsStore(dataDir, {
    environment: {},
    now: () => FIXED_TIME,
    validateCandidate: async () => {
      throw new Error("unresolved credentials must fail before provider work");
    }
  });
  await restarted.init(2);

  assert.equal((await restarted.loadView()).activeRevision, 1);
  assert.equal(
    (await readSettingsState(dataDir)).lastActivationOutcome?.errorCode,
    "credential_unresolved"
  );
});

test("pending replacement retains the active revision secret until activation", async (t) => {
  const dataDir = await initializedFormat2Directory(
    t,
    "1667-pending-secret-union-"
  );
  const secretId = "builtin:dry-run";
  const stored = storedDocument(secretId);
  const first = new SettingsStore(dataDir, {
    environment: {},
    now: () => FIXED_TIME,
    validateCandidate: async () => true
  });
  await first.init(2);
  await first.save({
    ...saveCommand(MUTATION_A, 1, stored),
    connectionSecrets: { [secretId]: STORED_SECRET }
  });

  const active = new SettingsStore(dataDir, {
    environment: {},
    now: () => FIXED_TIME,
    validateCandidate: async () => true
  });
  await active.init(2);
  const activeView = await active.loadView();
  if (!activeView.editable) throw new Error("format-2 view must be editable");
  const connection = stored.connections["builtin:dry-run"]!;
  const dropped: SettingsDocumentV2 = {
    ...stored,
    connections: {
      ...stored.connections,
      "builtin:dry-run": { ...connection, auth: { type: "none" } }
    }
  };
  await active.save({
    ...saveCommand(MUTATION_B, activeView.stateGeneration, dropped),
    connectionSecrets: { [secretId]: null }
  });

  assert.equal(
    (await readProviderSecrets(dataDir)).get(secretId),
    STORED_SECRET
  );
  const pendingView = await active.loadView();
  assert.equal(pendingView.activeRevision, activeView.activeRevision);
  assert.notEqual(pendingView.pendingRevision, null);

  const activated = new SettingsStore(dataDir, {
    environment: {},
    now: () => FIXED_TIME,
    validateCandidate: async () => true
  });
  await activated.init(2);

  assert.equal((await readProviderSecrets(dataDir)).has(secretId), false);
  assert.equal((await activated.loadView()).pendingRevision, null);
});

test("a failed document stage does not replace the active stored secret", async (t) => {
  const dataDir = await initializedFormat2Directory(
    t,
    "1667-provider-secret-stage-failure-"
  );
  const secretId = "builtin:dry-run";
  const document = storedDocument(secretId);
  const first = new SettingsStore(dataDir, {
    environment: {},
    now: () => FIXED_TIME,
    validateCandidate: async () => true
  });
  await first.init(2);
  await first.save({
    ...saveCommand(MUTATION_A, 1, document),
    connectionSecrets: { [secretId]: STORED_SECRET }
  });

  const active = new SettingsStore(dataDir, {
    environment: {},
    now: () => FIXED_TIME,
    validateCandidate: async () => true
  });
  await active.init(2);
  const view = await active.loadView();
  if (!view.editable) throw new Error("format-2 view must be editable");
  await mkdir(path.join(dataDir, SETTINGS_STATE_V2_NEXT_FILE));

  await assert.rejects(active.save({
    ...saveCommand(MUTATION_B, view.stateGeneration, {
      ...document,
      writing: { defaultAuthorBrief: "A staged document change." }
    }),
    connectionSecrets: { [secretId]: "replacement-secret" }
  }));
  assert.equal(
    (await readProviderSecrets(dataDir)).get(secretId),
    STORED_SECRET
  );
});

test("discarding a candidate prunes its newly stored connection secret", async (t) => {
  const dataDir = await initializedFormat2Directory(
    t,
    "1667-provider-secret-discard-"
  );
  const secretId = "candidate:connection";
  const document = candidateStoredConnectionDocument(secretId);
  const store = new SettingsStore(dataDir, {
    environment: {},
    now: () => FIXED_TIME
  });
  await store.init(2);
  await store.save({
    ...saveCommand(MUTATION_A, 1, document),
    connectionSecrets: { [secretId]: STORED_SECRET }
  });
  assert.equal(
    (await readProviderSecrets(dataDir)).get(secretId),
    STORED_SECRET
  );

  await store.discardPending({
    transportOperationId: "transport:discard-candidate-secret",
    mutationId: MUTATION_B,
    expectedStateGeneration: 2
  });

  assert.equal((await readProviderSecrets(dataDir)).has(secretId), false);
});

function storedDocument(secretId: string): SettingsDocumentV2 {
  const base = credentialedDocument("AI_1667_REPLACED_ENV_KEY");
  const connection = base.connections["builtin:dry-run"]!;
  return {
    ...base,
    connections: {
      ...base.connections,
      "builtin:dry-run": {
        ...connection,
        auth: { type: "bearer-stored", secretId }
      }
    }
  };
}

function candidateStoredConnectionDocument(secretId: string): SettingsDocumentV2 {
  const base = credentialedDocument("AI_1667_REPLACED_ENV_KEY");
  const model = base.models["builtin:dry-run"]!;
  const connection = base.connections["builtin:dry-run"]!;
  return {
    ...base,
    connections: {
      ...base.connections,
      [secretId]: {
        ...connection,
        auth: { type: "bearer-stored", secretId }
      }
    },
    models: {
      ...base.models,
      "builtin:dry-run": { ...model, connectionId: secretId }
    }
  };
}
