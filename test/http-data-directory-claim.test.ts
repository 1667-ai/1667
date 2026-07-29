import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  deriveHttpDataDirectoryClaimId,
  linuxMountOwnershipNamespace
} from "../server/http-data-directory-claim.js";
import { startHttpListener } from "../server/http-listener.js";
import { StoryService } from "../server/story-service.js";

const linuxTest = process.platform === "linux" ? test : test.skip;

test("Btrfs snapshots and remounts get independent live claims", () => {
  const canonicalFile = "/project/data-id";
  const bootId = "00112233-4455-6677-8899-aabbccddeeff";
  const stackedMounts = [
    "41 1 0:41 / /project rw - ext4 /dev/vdb rw",
    "42 41 0:42 / /project rw - btrfs /dev/vda rw"
  ].join("\n");
  const originalNamespace = linuxMountOwnershipNamespace({
    canonicalPath: canonicalFile,
    mountInfo: stackedMounts,
    visibleMountId: "42",
    uniqueMountId: "100",
    fileHandle: `1:${"01".repeat(8)}`,
    bootId,
    device: 42n,
    inode: 256n,
    btrfsIdentity: {
      fileSystemId: "aa".repeat(16),
      rootId: "256"
    }
  });
  const snapshotNamespace = linuxMountOwnershipNamespace({
    canonicalPath: canonicalFile,
    mountInfo: stackedMounts,
    visibleMountId: "42",
    uniqueMountId: "100",
    fileHandle: `1:${"01".repeat(8)}`,
    bootId,
    device: 42n,
    inode: 256n,
    btrfsIdentity: {
      fileSystemId: "aa".repeat(16),
      rootId: "257"
    }
  });
  const remountedNamespace = linuxMountOwnershipNamespace({
    canonicalPath: canonicalFile,
    mountInfo: [
      "41 1 0:41 / /project rw - ext4 /dev/vdb rw",
      "99 41 0:42 / /project rw - btrfs /dev/vda rw"
    ].join("\n"),
    visibleMountId: "99",
    uniqueMountId: "200",
    fileHandle: `1:${"01".repeat(8)}`,
    bootId,
    device: 999n,
    inode: 256n,
    btrfsIdentity: {
      fileSystemId: "aa".repeat(16),
      rootId: "256"
    }
  });
  const otherFileSystemNamespace = linuxMountOwnershipNamespace({
    canonicalPath: canonicalFile,
    mountInfo: stackedMounts,
    visibleMountId: "42",
    uniqueMountId: "100",
    fileHandle: `1:${"01".repeat(8)}`,
    bootId,
    device: 42n,
    inode: 256n,
    btrfsIdentity: {
      fileSystemId: "bb".repeat(16),
      rootId: "256"
    }
  });
  const common = {
    machineKey: "11".repeat(32),
    dataDirectoryId: "22".repeat(32)
  };

  assert.notEqual(originalNamespace, snapshotNamespace);
  assert.notEqual(originalNamespace, remountedNamespace);
  assert.notEqual(originalNamespace, otherFileSystemNamespace);
  assert.notEqual(
    deriveHttpDataDirectoryClaimId({
      ...common,
      ownershipNamespace: originalNamespace
    }),
    deriveHttpDataDirectoryClaimId({
      ...common,
      ownershipNamespace: snapshotNamespace
    })
  );
});

test("reused Linux mount IDs and inodes cannot inherit a live claim", () => {
  const common = {
    canonicalPath: "/project/data-id",
    device: 42n,
    inode: 256n,
    fileHandle: `1:${"01".repeat(8)}`,
    bootId: "00112233-4455-6677-8899-aabbccddeeff"
  };
  const before = linuxMountOwnershipNamespace({
    ...common,
    mountInfo: "42 1 0:42 / /project rw - ext4 /dev/loop0 rw",
    visibleMountId: "42",
    uniqueMountId: "100"
  });
  const after = linuxMountOwnershipNamespace({
    ...common,
    mountInfo: "42 1 0:42 / /project rw - ext4 /dev/loop0 rw",
    visibleMountId: "42",
    uniqueMountId: "200"
  });
  const afterRestart = linuxMountOwnershipNamespace({
    ...common,
    bootId: "ffeeddcc-bbaa-9988-7766-554433221100",
    mountInfo: "42 1 0:42 / /project rw - ext4 /dev/loop0 rw",
    visibleMountId: "42",
    uniqueMountId: "100"
  });
  const reusedInode = linuxMountOwnershipNamespace({
    ...common,
    fileHandle: `1:${"02".repeat(8)}`,
    mountInfo: "42 1 0:42 / /project rw - ext4 /dev/loop0 rw",
    visibleMountId: "42",
    uniqueMountId: "100"
  });

  assert.notEqual(before, after);
  assert.notEqual(before, afterRestart);
  assert.notEqual(before, reusedInode);
  assert.throws(
    () => linuxMountOwnershipNamespace({
      ...common,
      fileHandle: `ephemeral:${"03".repeat(32)}`,
      mountInfo: "42 1 0:42 / /project rw - overlay overlay rw",
      visibleMountId: "42",
      uniqueMountId: "100"
    }),
    /cannot identify the filesystem/
  );
});

linuxTest("concurrent listeners share first machine claim key safely", async (t) => {
  const listenerCount = 8;
  const root = await mkdtemp(path.join(tmpdir(), "1667-http-claim-race-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = path.join(root, "state");
  await mkdir(stateRoot, { mode: 0o700 });
  let initialized = 0;
  let release!: () => void;
  const bothInitialized = new Promise<void>((resolve) => {
    release = resolve;
  });

  class CoordinatedStoryService extends StoryService {
    override async init(): Promise<void> {
      await super.init();
      initialized += 1;
      if (initialized === listenerCount) release();
      await bothInitialized;
    }
  }

  const start = async (name: string) => {
    const dataDir = path.join(root, name);
    return await startHttpListener({
      port: 0,
      authStore: { stateRoot },
      project: { root: dataDir, dataDir },
      serviceFactory: async (errorReporter, machineDir) =>
        new CoordinatedStoryService({
          dataDir,
          machineDir,
          errorReporter
        })
    });
  };
  const listeners = await Promise.all(Array.from(
    { length: listenerCount },
    async (_value, index) => await start(`listener-${index}`)
  ));
  t.after(async () => {
    await Promise.all(listeners.map(async (listener) => {
      await listener.close();
    }));
  });

  assert.equal(
    new Set(listeners.map((listener) => listener.origin)).size,
    listenerCount
  );
});
