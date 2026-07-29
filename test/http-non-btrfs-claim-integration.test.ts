import assert from "node:assert/strict";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import {
  readHttpDataDirectoryClaimId
} from "../server/http-data-directory-claim.js";
import {
  retainedDirectoryOpenFlags
} from "../server/retained-directory-authority.js";

const root = process.env.AI_1667_NON_BTRFS_TEST_ROOT;
const machine = process.env.AI_1667_NON_BTRFS_TEST_MACHINE;
const recordFile = process.env.AI_1667_NON_BTRFS_TEST_RECORD;
const mode = process.env.AI_1667_NON_BTRFS_TEST_MODE;
const isArmed = root !== undefined
  && machine !== undefined
  && recordFile !== undefined
  && (mode === "capture" || mode === "verify");

test("a cloned non-Btrfs mount cannot inherit its source claim", {
  skip: !isArmed
}, async () => {
  if (!isArmed) return;
  await mkdir(machine, { recursive: true, mode: 0o700 });
  const handle = await open(root, retainedDirectoryOpenFlags());
  const info = await handle.stat({ bigint: true }).finally(
    async () => await handle.close()
  );
  const claimId = await readHttpDataDirectoryClaimId({
    machineDirectory: machine,
    dataDirectoryId: "11".repeat(32),
    dataDirectory: root
  });
  const observed = {
    claimId,
    device: info.dev.toString(),
    inode: info.ino.toString()
  };

  if (mode === "capture") {
    await writeFile(recordFile, `${JSON.stringify(observed)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    return;
  }
  const original = JSON.parse(await readFile(recordFile, "utf8")) as {
    readonly claimId: string;
    readonly device: string;
    readonly inode: string;
  };
  assert.equal(observed.device, original.device);
  assert.equal(observed.inode, original.inode);
  assert.notEqual(observed.claimId, original.claimId);
});
