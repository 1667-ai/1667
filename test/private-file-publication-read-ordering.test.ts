import assert from "node:assert/strict";
import { link, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  publishPrivateFileNoReplace,
  readOptionalPrivateFile
} from "../server/private-file-publication.js";

const POLICY = { label: "probe reserved file", maxBytes: 4096 };
const BYTES = Buffer.from('{"probe":true}', "utf8");

// `publishPrivateFileNoReplace` publishes with `link(scratch, file)`, then
// deliberately holds both names — nlink === 2 on purpose — until it verifies
// the pair and fsyncs the directory, and only then unlinks the scratch. A
// reader that lands in that window must wait it out, not fail closed.
test("a read landing during publishPrivateFileNoReplace observes the committed file, not the transient two-link window", async (t) => {
  const dataDir = await temporaryDirectory(t, "1667-publication-read-ordering-");

  // The window is real but brief (a handful of local syscalls plus one
  // directory fsync), so run many independent publish/read pairs concurrently
  // with each other. The resulting I/O contention makes at least one read
  // land inside some publication's window, on real disk I/O, with high
  // reliability — the same way the reported CI flake needs contention to
  // surface at all.
  const rounds = 40;
  const failures: string[] = [];

  await Promise.all(Array.from({ length: rounds }, async (_unused, round) => {
    const file = path.join(dataDir, `reserved-${round}.bin`);
    let stop = false;
    const hammer = (async () => {
      while (!stop) {
        try {
          const value = await readOptionalPrivateFile(file, POLICY);
          if (value !== null) assert.deepEqual(value, BYTES);
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
          stop = true;
        }
      }
    })();
    await publishPrivateFileNoReplace(file, BYTES, POLICY);
    stop = true;
    await hammer;
  }));

  assert.deepEqual(
    failures,
    [],
    "a concurrent read must never observe publishPrivateFileNoReplace's own "
      + "transient two-link window as an unsafe link count"
  );
});

// The reader must still fail closed, immediately and with no retry budget
// spent, on a link count it cannot explain as its own publication. Widening
// tolerance to "nlink === 2, no questions asked" would silently accept a
// genuine second hard link to a reserved file.
test("a read still rejects a link count it cannot attribute to its own publication", async (t) => {
  if (process.platform === "win32") {
    t.skip("hard-link identity checks are POSIX-specific");
    return;
  }
  const dataDir = await temporaryDirectory(t, "1667-publication-read-ordering-alias-");
  const file = path.join(dataDir, "reserved.bin");
  await publishPrivateFileNoReplace(file, BYTES, POLICY);

  // A second hard link that has nothing to do with the scratch-suffixed
  // publication protocol: a genuine alias, not a publication in progress.
  const alias = path.join(dataDir, "reserved.bin.unrelated-alias");
  await link(file, alias);

  const start = Date.now();
  await assert.rejects(
    readOptionalPrivateFile(file, POLICY),
    /unsafe link count/
  );
  const elapsedMs = Date.now() - start;
  assert.ok(
    elapsedMs < 500,
    `a genuine alias must be rejected immediately, not after a retry budget (took ${elapsedMs}ms)`
  );
});

async function temporaryDirectory(t: TestContext, prefix: string): Promise<string> {
  const dataDir = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return dataDir;
}
