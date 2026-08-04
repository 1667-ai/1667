import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { readOptionalPrivateFile } from "../server/private-file-publication.js";

// Six on-disk shapes a reserved file's link count can take. Each must settle
// (resolve or reject) fast: recovery orders itself against a live writer's
// own lock, never against elapsed time, so a state with no live writer to
// wait for must never wait at all, and a state with one must wait only long
// enough to prove that with certainty. Regression coverage for a defect
// where two "decide again from fresh state" paths could recurse forever on a
// stable-but-unacceptable state (a hard-link-preserving backup, or a crashed
// publication overwritten by one) instead of failing closed like every other
// unsafe shape here.
const POLICY = { label: "probe reserved file", maxBytes: 4096 };
const SCRATCH_SUFFIX = ".1667-publish-v1.tmp";
const SETTLE_DEADLINE_MS = 5_000;

test("every unsafe link-count shape settles well within the deadline", async (t) => {
  const dir = await temporaryDirectory(t, "1667-link-count-states-");

  await assertSettles(dir, "healthy-single-link", async (file) => {
    const handle = await open(file, "wx", 0o600);
    await handle.writeFile('{"probe":true}');
    await handle.close();
  }, { resolves: true });

  await assertSettles(dir, "alias-unrelated-path", async (file, _scratch, entryDir) => {
    const handle = await open(file, "wx", 0o600);
    await handle.writeFile('{"probe":true}');
    await handle.close();
    await link(file, path.join(entryDir, "unrelated-alias"));
  }, { resolves: false });

  await assertSettles(dir, "alias-plus-distinct-scratch", async (file, scratch, entryDir) => {
    const handle = await open(file, "wx", 0o600);
    await handle.writeFile('{"probe":true}');
    await handle.close();
    await link(file, path.join(entryDir, "unrelated-alias"));
    const scratchHandle = await open(scratch, "wx", 0o600);
    await scratchHandle.writeFile('{"probe":true}');
    await scratchHandle.close();
  }, { resolves: false });

  await assertSettles(dir, "forged-proven-window", async (file, scratch) => {
    const handle = await open(file, "wx", 0o600);
    await handle.writeFile('{"forged":true}');
    await handle.close();
    await link(file, scratch);
  }, { resolves: true });

  // Same inode, nlink 3: what a hard-link-preserving backup (`cp -al`,
  // `rsync --link-dest`) leaves behind over a crashed publication pair.
  await assertSettles(dir, "same-inode-nlink-3", async (file, scratch, entryDir) => {
    const handle = await open(file, "wx", 0o600);
    await handle.writeFile('{"probe":true}');
    await handle.close();
    await link(file, scratch);
    await link(file, path.join(entryDir, "backup-copy"));
  }, { resolves: false });

  // A lone abandoned scratch (final absent) that a backup gave a second link
  // -- an alias at the conventional scratch path itself, not an unrelated
  // one, reached through a second name that has nothing to do with
  // publication.
  await assertSettles(dir, "lone-scratch-nlink-2", async (_file, scratch, entryDir) => {
    const handle = await open(scratch, "wx", 0o600);
    await handle.writeFile('{"probe":true}');
    await handle.close();
    await link(scratch, path.join(entryDir, "backup-copy"));
  }, { resolves: false });
});

async function assertSettles(
  dir: string,
  name: string,
  build: (file: string, scratch: string, entryDir: string) => Promise<void>,
  expectation: { readonly resolves: boolean }
): Promise<void> {
  const entryDir = path.join(dir, name);
  await mkdir(entryDir, { mode: 0o700 });
  const file = path.join(entryDir, "reserved.bin");
  const scratch = `${file}${SCRATCH_SUFFIX}`;
  await build(file, scratch, entryDir);

  const started = Date.now();
  const outcome = await Promise.race([
    readOptionalPrivateFile(file, POLICY).then(
      () => ({ kind: "resolved" as const }),
      (error: unknown) => ({ kind: "rejected" as const, error })
    ),
    new Promise<{ kind: "timeout" }>((resolve) =>
      setTimeout(() => resolve({ kind: "timeout" }), SETTLE_DEADLINE_MS))
  ]);
  const elapsedMs = Date.now() - started;

  assert.notEqual(
    outcome.kind,
    "timeout",
    `${name}: did not settle within ${SETTLE_DEADLINE_MS}ms (main resolves this in well under 100ms)`
  );
  assert.ok(
    elapsedMs < SETTLE_DEADLINE_MS,
    `${name}: settled in ${elapsedMs}ms, expected fast failure or resolution`
  );
  if (expectation.resolves) {
    assert.equal(outcome.kind, "resolved", `${name}: expected a successful read`);
  } else {
    assert.equal(outcome.kind, "rejected", `${name}: expected a fail-closed rejection`);
  }
}

async function temporaryDirectory(t: TestContext, prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
