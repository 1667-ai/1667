import assert from "node:assert/strict";
import test from "node:test";
import {
  LINUX_IDENTITY_HANDLE_FLAGS,
  readLinuxFileHandleWithCall
} from "../server/linux-file-handle.js";

test("Linux file handles retain opaque inode-generation identity", () => {
  let observedFlags = 0;
  const observed = readLinuxFileHandleWithCall(
    41,
    "/project",
    (fileDescriptor, handle, mountId, flags) => {
      observedFlags = flags;
      assert.equal(fileDescriptor, 41);
      assert.equal(handle.readUInt32LE(0), 128);
      handle.writeUInt32LE(8, 0);
      handle.writeInt32LE(1, 4);
      handle.set(Buffer.from("0102030405060708", "hex"), 8);
      mountId.writeInt32LE(72, 0);
      return 0;
    }
  );

  assert.equal(observed, "1:0102030405060708");
  assert.equal(observedFlags, LINUX_IDENTITY_HANDLE_FLAGS);
  assert.equal(observedFlags, 0x1200);
});

test("unsupported Linux file handles select conservative identity", () => {
  assert.equal(
    readLinuxFileHandleWithCall(
      41,
      "/project",
      () => -1
    ),
    null
  );
});
