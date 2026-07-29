import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, open, rename } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  readBtrfsIdentity
} from "../server/http-btrfs-identity-node.js";
import {
  retainedDirectoryOpenFlags
} from "../server/retained-directory-authority.js";

const execFileAsync = promisify(execFile);
const btrfsRoot = process.env.AI_1667_BTRFS_TEST_ROOT;

test("Node Btrfs identity stays on a retained directory after replacement", {
  skip: btrfsRoot === undefined
}, async () => {
  if (btrfsRoot === undefined) return;
  await mkdir(btrfsRoot, { recursive: true });
  const selected = path.join(btrfsRoot, "selected");
  const replacement = path.join(btrfsRoot, "replacement");
  const detached = path.join(btrfsRoot, "detached");
  await Promise.all([
    createSubvolume(selected),
    createSubvolume(replacement)
  ]);
  const retained = await open(selected, retainedDirectoryOpenFlags());
  try {
    await rename(selected, detached);
    await rename(replacement, selected);
    const [observed, detachedIdentity, replacementIdentity] =
      await Promise.all([
        readBtrfsIdentity(retained.fd, selected),
        identityAt(detached),
        identityAt(selected)
      ]);
    assert.deepEqual(observed, detachedIdentity);
    assert.notEqual(observed.rootId, replacementIdentity.rootId);
  } finally {
    await retained.close();
  }
});

async function createSubvolume(directory: string): Promise<void> {
  await execFileAsync("btrfs", ["subvolume", "create", directory]);
}

async function identityAt(directory: string): Promise<{
  readonly fileSystemId: string;
  readonly rootId: string;
}> {
  const handle = await open(directory, retainedDirectoryOpenFlags());
  try {
    return await readBtrfsIdentity(handle.fd, directory);
  } finally {
    await handle.close();
  }
}
