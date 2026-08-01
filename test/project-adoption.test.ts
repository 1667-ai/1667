import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  DATA_DIRECTORY_OWNER_MARKER,
  LEGACY_DATA_OWNER_MARKER,
  PROVIDER_SECRETS_FILE
} from "../server/data-directory-layout.js";
import { dataDirectoryOwnerMarkerText } from "../server/data-directory-format.js";
import { INITIAL_SETTINGS_STATE_V2_TEXT } from "../server/settings-v2-default.js";
import { adoptDataDirectory } from "../server/project-adoption.js";
import { projectDirectory } from "../server/project-layout.js";
import { readProviderSecrets } from "../server/provider-secret-store.js";

const SECRET = "sk-adopted-fixture-value";

test("adoption moves stories in and lands the secret in the machine tier", async (t) => {
  const { source, projectRoot, machineDir } = await fixture(t);
  await writeFile(
    path.join(source, PROVIDER_SECRETS_FILE),
    `{"connection:one":"${SECRET}"}`,
    { mode: 0o600 }
  );

  const adoption = await adoptDataDirectory({ source, projectRoot, machineDir });

  assert.equal(adoption.project.directory, await realpath(projectDirectory(projectRoot)));
  assert.deepEqual([...adoption.relocatedSecretIds], ["connection:one"]);
  assert.equal(
    await readFile(path.join(adoption.project.directory, "stories", "one.json"), "utf8"),
    "{}\n"
  );
  // The adopted settings document is carried across untouched.
  assert.equal(
    await readFile(
      path.join(adoption.project.directory, "settings.v2.state.json"),
      "utf8"
    ),
    INITIAL_SETTINGS_STATE_V2_TEXT
  );

  // The secret is in the machine tier and gone from the adopted folder.
  assert.equal((await readProviderSecrets(machineDir)).get("connection:one"), SECRET);
  assert.equal(
    (await readdir(adoption.project.directory)).includes(PROVIDER_SECRETS_FILE),
    false
  );
  assert.equal((await readdir(source)).includes(PROVIDER_SECRETS_FILE), false);

  // The project carries the current marker, not the legacy one.
  assert.equal(
    await readFile(path.join(adoption.project.directory, DATA_DIRECTORY_OWNER_MARKER), "utf8"),
    dataDirectoryOwnerMarkerText(4)
  );
  assert.equal(
    (await readdir(adoption.project.directory)).includes(LEGACY_DATA_OWNER_MARKER),
    false
  );
});

test("a conflicting machine secret refuses and moves nothing", async (t) => {
  const { source, projectRoot, machineDir } = await fixture(t);
  await writeFile(
    path.join(source, PROVIDER_SECRETS_FILE),
    `{"connection:one":"${SECRET}"}`,
    { mode: 0o600 }
  );
  await writeFile(
    path.join(machineDir, PROVIDER_SECRETS_FILE),
    '{"connection:one":"sk-a-different-value"}',
    { mode: 0o600 }
  );

  await assert.rejects(
    adoptDataDirectory({ source, projectRoot, machineDir }),
    /already holds a different secret for connection:one/
  );

  // Both sides are exactly as they were.
  assert.equal((await readProviderSecrets(source)).get("connection:one"), SECRET);
  assert.equal(
    (await readProviderSecrets(machineDir)).get("connection:one"),
    "sk-a-different-value"
  );
  assert.deepEqual((await readdir(source)).includes("stories"), true);
});

test("unreadable settings state is refused before anything moves", async (t) => {
  const { source, projectRoot, machineDir } = await fixture(t);
  await writeFile(path.join(source, "settings.v2.state.json"), "{}\n", { mode: 0o600 });

  await assert.rejects(
    adoptDataDirectory({ source, projectRoot, machineDir }),
    /is not settings state this build can read/
  );

  assert.equal((await readdir(source)).includes("stories"), true);
  await assert.rejects(readdir(projectDirectory(projectRoot)), /ENOENT/);
});

test("adoption refuses a directory with no owner marker", async (t) => {
  const { projectRoot, machineDir } = await fixture(t);
  const stranger = await temporaryDirectory(t, "1667-adopt-stranger-");
  await writeFile(path.join(stranger, "notes.txt"), "not ours\n");

  await assert.rejects(
    adoptDataDirectory({ source: stranger, projectRoot, machineDir }),
    /carries no 1667 owner marker/
  );
  await assert.rejects(
    adoptDataDirectory({
      source: path.join(stranger, "absent"),
      projectRoot,
      machineDir
    }),
    /there is no 1667 data directory/
  );
});

test("adoption refuses a project that already holds stories", async (t) => {
  const { source, projectRoot, machineDir } = await fixture(t);
  const directory = projectDirectory(projectRoot);
  await mkdir(path.join(directory, "stories"), { recursive: true });

  await assert.rejects(
    adoptDataDirectory({ source, projectRoot, machineDir }),
    /already holds stories/
  );
  assert.equal((await readdir(source)).includes("stories"), true);
});

async function fixture(t: TestContext): Promise<{
  source: string;
  projectRoot: string;
  machineDir: string;
}> {
  const source = await temporaryDirectory(t, "1667-adopt-source-");
  await writeFile(
    path.join(source, LEGACY_DATA_OWNER_MARKER),
    dataDirectoryOwnerMarkerText(3),
    { mode: 0o600 }
  );
  await writeFile(
    path.join(source, "settings.v2.state.json"),
    INITIAL_SETTINGS_STATE_V2_TEXT,
    { mode: 0o600 }
  );
  await mkdir(path.join(source, "stories"));
  await writeFile(path.join(source, "stories", "one.json"), "{}\n", { mode: 0o600 });
  return {
    source,
    projectRoot: await temporaryDirectory(t, "1667-adopt-project-"),
    machineDir: await temporaryDirectory(t, "1667-adopt-machine-")
  };
}

async function temporaryDirectory(t: TestContext, prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  t.after(async () => await rm(directory, { recursive: true, force: true }));
  return directory;
}
