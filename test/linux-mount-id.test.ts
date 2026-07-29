import assert from "node:assert/strict";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import test from "node:test";
import {
  readLinuxUniqueMountId
} from "../server/linux-mount-id-node.js";
import {
  decodeLinuxUniqueMountId,
  linuxStatxSyscallNumber,
  LINUX_STATX_MOUNT_ID_MASK,
  statxMountIdBuffer
} from "../server/linux-mount-id.js";

test("statx mount identity requires the non-reusable kernel result", () => {
  const statx = statxMountIdBuffer();
  statx.writeUInt32LE(LINUX_STATX_MOUNT_ID_MASK, 0);
  statx.writeBigUInt64LE(18_446_744_073_709_551_614n, 0x90);

  assert.equal(
    decodeLinuxUniqueMountId(0, statx, "/project"),
    "18446744073709551614"
  );
  assert.throws(
    () => decodeLinuxUniqueMountId(-1, statx, "/project"),
    /cannot identify the Linux mount generation/
  );
  statx.writeUInt32LE(0, 0);
  assert.throws(
    () => decodeLinuxUniqueMountId(0, statx, "/project"),
    /cannot identify the Linux mount generation/
  );
});

test("Node reuses one stable libc mount-ID binding", {
  skip: process.platform !== "linux"
}, async () => {
  const directory = await open(".", constants.O_RDONLY);
  try {
    const expected = await readLinuxUniqueMountId(
      directory.fd,
      process.cwd()
    );
    assert.match(expected, /^[1-9][0-9]*$/);
    for (let attempt = 0; attempt < 256; attempt += 1) {
      assert.equal(
        await readLinuxUniqueMountId(directory.fd, process.cwd()),
        expected
      );
    }
  } finally {
    await directory.close();
  }
});

test("statx syscall numbers cover each supported Linux architecture", () => {
  assert.equal(linuxStatxSyscallNumber("x64"), 332n);
  assert.equal(linuxStatxSyscallNumber("arm64"), 291n);
  assert.throws(
    () => linuxStatxSyscallNumber("ia32"),
    /cannot query Linux mount identity/
  );
});
