import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RELEASE_LAUNCHER_PACKAGE } from "../../shared/release-targets.js";
import { createUpdateCacheEntry, type UpdateCacheKey } from "../src/update-cache.js";
import {
  UPDATE_CACHE_FILE,
  readPersistedUpdateCache,
  writePersistedUpdateCache
} from "../src/update-cache-store.js";

const roots: string[] = [];
const key: UpdateCacheKey = {
  metadataKind: "npm",
  metadataOrigin: "https://registry.npmjs.org",
  packageName: RELEASE_LAUNCHER_PACKAGE,
  installIdentity: "manual:source:0.1.0",
  currentVersion: "0.1.0",
  artifactTarget: "source",
  channel: "stable",
  prereleasePolicy: "stable-only"
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("private update cache store", () => {
  test("round-trips and atomically replaces a notification hint", async () => {
    const root = await privateRoot();
    const first = createUpdateCacheEntry(key, "0.2.0", 1_000);
    const second = createUpdateCacheEntry(key, "0.3.0", 2_000);
    expect(await writePersistedUpdateCache(first, { stateRoot: root })).toBeTrue();
    expect((await readPersistedUpdateCache(key, 1_001, { stateRoot: root }))?.latest).toBe("0.2.0");
    expect(await writePersistedUpdateCache(second, { stateRoot: root })).toBeTrue();
    expect((await readPersistedUpdateCache(key, 2_001, { stateRoot: root }))?.latest).toBe("0.3.0");
    expect((await readFile(path.join(root, UPDATE_CACHE_FILE))).byteLength).toBeGreaterThan(0);
  });

  test("unsafe roots and symlinked cache files fail as cache misses", async () => {
    if (process.platform === "win32") return;
    const root = await privateRoot();
    await chmod(root, 0o755);
    expect(await writePersistedUpdateCache(
      createUpdateCacheEntry(key, "0.2.0", 1_000),
      { stateRoot: root }
    )).toBeFalse();
    expect(
      await readPersistedUpdateCache(key, 1_001, { stateRoot: root })
    ).toBe(null);
    await chmod(root, 0o700);
    const target = path.join(root, "target");
    await writeFile(target, "{}");
    await symlink(target, path.join(root, UPDATE_CACHE_FILE));
    expect(await readPersistedUpdateCache(key, 1_001, { stateRoot: root })).toBe(null);
  });
});

async function privateRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "1667-update-cache-"));
  roots.push(root);
  await chmod(root, 0o700);
  return root;
}
