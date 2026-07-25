import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  PROVIDER_SECRETS_FILE,
  PROVIDER_SECRETS_NEXT_FILE,
  PROVIDER_SECRETS_NEXT_SCRATCH,
  SETTINGS_STATE_V2_FILE
} from "../server/data-directory-layout.js";
import {
  MACHINE_TIER_OVERRIDE_VARIABLE,
  resolveMachineTierRoot
} from "../server/machine-tier.js";
import { assertNoProjectTierSecrets } from "../server/project-secret-fence.js";
import { readProviderSecrets } from "../server/provider-secret-store.js";
import { resolveProviderHeaders } from "../server/provider-runtime.js";
import { SettingsStore } from "../server/settings.js";
import type { SettingsDocumentV2 } from "../shared/settings-v2-types.js";
import {
  FIXED_TIME,
  MUTATION_A,
  credentialedDocument,
  initializedFormat2Directory,
  saveCommand,
  transactionBytes
} from "./settings-store-fixtures.js";

const STORED_SECRET = "sk-machine-tier-fixture-value";

test("machine tier honours an absolute override and creates it private", async (t) => {
  const parent = await temporaryDirectory(t, "1667-machine-tier-");
  const override = path.join(parent, "state");

  const root = await resolveMachineTierRoot({ override });

  assert.equal(root, override);
  if (process.platform !== "win32") {
    assert.equal((await lstat(root)).mode & 0o777, 0o700);
  }
  assert.equal(
    await resolveMachineTierRoot({
      environment: { [MACHINE_TIER_OVERRIDE_VARIABLE]: override }
    }),
    override
  );
});

test("machine tier rejects a relative override", async () => {
  await assert.rejects(
    resolveMachineTierRoot({ override: "relative/state" }),
    /must be an absolute path/
  );
});

test("stored provider secrets are published in the machine tier only", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-secrets-tier-");
  const machineDir = await resolveMachineTierRoot({
    override: path.join(await temporaryDirectory(t, "1667-machine-root-"), "state")
  });
  const secretId = "builtin:dry-run";
  const store = new SettingsStore(dataDir, {
    environment: {},
    now: () => FIXED_TIME,
    secretsDir: machineDir
  });
  await store.init(2);
  await store.save({
    ...saveCommand(MUTATION_A, 1, storedDocument(secretId)),
    connectionSecrets: { [secretId]: STORED_SECRET }
  });

  assert.equal((await readProviderSecrets(machineDir)).get(secretId), STORED_SECRET);
  assert.equal((await readProviderSecrets(dataDir)).size, 0);
  await assert.rejects(
    stat(path.join(dataDir, PROVIDER_SECRETS_FILE)),
    (error: unknown) => isErrorCode(error, "ENOENT")
  );

  // The project tier keeps the settings document; it carries only the opaque ID.
  const state = await readFile(path.join(dataDir, SETTINGS_STATE_V2_FILE), "utf8");
  assert.equal(state.includes(secretId), true);
  assert.equal(state.includes(STORED_SECRET), false);
  for (const bytes of await transactionBytes(dataDir, MUTATION_A)) {
    assert.equal(bytes.includes(STORED_SECRET), false);
  }

  const restarted = new SettingsStore(dataDir, {
    environment: {},
    now: () => FIXED_TIME,
    secretsDir: machineDir,
    validateCandidate: async (settings) => {
      assert.equal(
        resolveProviderHeaders(settings, {}).headers.authorization,
        `Bearer ${STORED_SECRET}`
      );
      return true;
    }
  });
  await restarted.init(2);
  assert.equal((await restarted.loadView()).activeRevision, 2);
});

test("a project tier holding a secret file is refused, naming the machine tier", async (t) => {
  const machineDir = await temporaryDirectory(t, "1667-fence-machine-");
  for (const entry of [
    PROVIDER_SECRETS_FILE,
    PROVIDER_SECRETS_NEXT_FILE,
    PROVIDER_SECRETS_NEXT_SCRATCH
  ]) {
    const projectDir = await temporaryDirectory(t, "1667-fence-project-");
    const file = path.join(projectDir, entry);
    await writeFile(file, "{}", { mode: 0o600 });

    await assert.rejects(
      assertNoProjectTierSecrets(projectDir, machineDir),
      (error: unknown) => {
        assert.equal(error instanceof Error && error.message.includes(file), true);
        assert.equal(
          error instanceof Error
            && error.message.includes(path.join(machineDir, entry)),
          true
        );
        return true;
      }
    );
  }
});

test("a project tier that is the machine tier has no secret to refuse", async (t) => {
  const directory = await temporaryDirectory(t, "1667-fence-same-");
  await writeFile(path.join(directory, PROVIDER_SECRETS_FILE), "{}", { mode: 0o600 });

  await assertNoProjectTierSecrets(directory, directory);
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

async function temporaryDirectory(t: TestContext, prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(async () => await rm(directory, { recursive: true, force: true }));
  return directory;
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
