import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
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

async function exists(target: string): Promise<boolean> {
  try {
    await realpath(target);
    return true;
  } catch {
    return false;
  }
}
