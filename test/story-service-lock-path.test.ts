import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DATA_DIRECTORY_ID_FILE,
  PROVIDER_SECRETS_FILE
} from "../server/data-directory-layout.js";
import { PROJECT_GITIGNORE_FILE } from "../server/project-layout.js";
import { RuntimeDataDirectoryLock } from "../server/runtime-data-directory.js";
import { StoryService } from "../server/story-service.js";

test("service storage stays bound to the canonical directory it locked", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-canonical-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = path.join(root, "original");
  const replacement = path.join(root, "replacement");
  const alias = path.join(root, "data");
  await mkdir(original);
  await mkdir(replacement);
  await symlink(original, alias, "dir");

  const service = StoryService.withoutDiagnostics({ dataDir: alias });
  await service.init();
  try {
    assert.equal(service.dataDir, await realpath(original));
    await unlink(alias);
    await symlink(replacement, alias, "dir");
    const story = await service.createStory("Canonical target");
    assert.equal((await service.listStories()).some(({ id }) => id === story.id), true);
    assert.equal(await exists(path.join(original, "stories", story.id)), true);
    assert.equal(await exists(path.join(replacement, "stories", story.id)), false);
  } finally {
    await service.dispose();
  }
});

test("transport-neutral service does not create HTTP identity files", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-service-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  const machineDir = path.join(root, "machine");
  await mkdir(machineDir);
  const service = StoryService.withoutDiagnostics({ dataDir, machineDir });
  await service.init();
  await service.dispose();

  assert.equal(await exists(path.join(dataDir, DATA_DIRECTORY_ID_FILE)), false);
  assert.equal(await exists(path.join(dataDir, PROJECT_GITIGNORE_FILE)), false);
});

test("external service checks secrets through retained directory authority", {
  skip: process.platform !== "linux"
}, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-retained-fence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = path.join(root, "project");
  const moved = path.join(root, "moved-project");
  const machineDir = path.join(root, "machine");
  await mkdir(machineDir);
  const authority = new RuntimeDataDirectoryLock(original);
  await authority.acquire();
  t.after(() => authority.release());
  await writeFile(
    path.join(original, PROVIDER_SECRETS_FILE),
    "{}",
    { mode: 0o600 }
  );
  await rename(original, moved);
  await mkdir(original);
  const service = StoryService.withoutDiagnostics({
    dataDir: authority.authorityPath,
    dataLock: "external",
    machineDir
  });

  await assert.rejects(
    service.init(),
    /refuses to open a project holding a machine secret file/
  );
});

async function exists(target: string): Promise<boolean> {
  try {
    await realpath(target);
    return true;
  } catch {
    return false;
  }
}
