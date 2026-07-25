import assert from "node:assert/strict";
import test from "node:test";
import { isVerifiedLocalFilesystem } from "../server/storage-filesystem.js";
import { darwinMountInfo } from "../server/storage-filesystem-node.js";
import { windowsDriveRoot } from "../server/storage-filesystem-windows.js";
import { posixLibcCandidates } from "../server/bun-ffi.js";
import { decodeDarwinStatfs } from "../server/storage-filesystem-bun.js";

test("storage filesystem policy accepts reviewed local filesystems", () => {
  assert.equal(isVerifiedLocalFilesystem("darwin", { type: 999n, typeName: "apfs", local: true }), true);
  assert.equal(isVerifiedLocalFilesystem("darwin", { type: 1n, typeName: "hfs", local: true }), true);
  assert.equal(isVerifiedLocalFilesystem("linux", { type: 0xef53n }), true);
  assert.equal(isVerifiedLocalFilesystem("linux", { type: 0x794c7630n }), true);
  assert.equal(isVerifiedLocalFilesystem("win32", { type: 3n }), true); // fixed
  assert.equal(isVerifiedLocalFilesystem("win32", { type: 2n }), true); // removable
});

test("Darwin mount parsing chooses the longest containing mount and requires local", () => {
  const mounts = [
    "/dev/disk on / (apfs, local, journaled)",
    "//server/share on /Volumes/Story Data (smbfs, nodev, nosuid)",
    "/dev/other on /Volumes/Local (hfs, local, journaled)"
  ].join("\n");
  assert.deepEqual(darwinMountInfo("/Volumes/Story Data/books", mounts), {
    type: 0n, typeName: "smbfs", local: false
  });
  assert.deepEqual(darwinMountInfo("/Volumes/Local/books", mounts), {
    type: 0n, typeName: "hfs", local: true
  });
});

test("storage filesystem policy rejects network and unknown filesystem types", () => {
  assert.equal(isVerifiedLocalFilesystem("linux", { type: 0x6969n }), false); // NFS
  assert.equal(isVerifiedLocalFilesystem("linux", { type: 0xff534d42n }), false); // CIFS
  assert.equal(isVerifiedLocalFilesystem("darwin", { type: 2n, typeName: "nfs", local: false }), false);
  assert.equal(isVerifiedLocalFilesystem("darwin", { type: 26n, typeName: "apfs", local: false }), false);
  assert.equal(isVerifiedLocalFilesystem("win32", { type: 4n }), false); // network
  assert.equal(isVerifiedLocalFilesystem("win32", { type: 0n }), false); // unknown
});

test("Windows drive probing accepts only a local drive root", () => {
  assert.equal(windowsDriveRoot(String.raw`D:\1667\Data`), "D:\\");
  assert.throws(() => windowsDriveRoot("1667"), /local Windows drive root/);
  assert.throws(
    () => windowsDriveRoot(String.raw`\\server\share\1667`),
    /local Windows drive root/
  );
});

test("Bun FFI probes both glibc and musl C libraries", () => {
  assert.deepEqual(posixLibcCandidates("linux", "x64"), [
    "libc.so.6",
    "libc.musl-x86_64.so.1",
    "/lib/ld-musl-x86_64.so.1",
    "/usr/lib/ld-musl-x86_64.so.1"
  ]);
  assert.ok(posixLibcCandidates("linux", "arm64").includes("libc.musl-aarch64.so.1"));
});

test("Bun decodes both Darwin statfs ABIs", () => {
  const arm = darwinStatfsFixture({
    typeOffset: 60,
    flagsOffset: 64,
    typeNameOffset: 72,
    legacy: false
  });
  assert.deepEqual(decodeDarwinStatfs(arm, "arm64"), {
    type: 26n,
    typeName: "apfs",
    local: true
  });

  const intel = darwinStatfsFixture({
    typeOffset: 78,
    flagsOffset: 80,
    typeNameOffset: 104,
    legacy: true
  });
  assert.deepEqual(decodeDarwinStatfs(intel, "x64"), {
    type: 26n,
    typeName: "apfs",
    local: true
  });
});

function darwinStatfsFixture(offsets: {
  typeOffset: number;
  flagsOffset: number;
  typeNameOffset: number;
  legacy: boolean;
}): Uint8Array {
  const storage = new Uint8Array(128);
  const view = new DataView(storage.buffer);
  if (offsets.legacy) {
    view.setUint16(offsets.typeOffset, 26, true);
    view.setBigUint64(offsets.flagsOffset, 0x1000n, true);
  } else {
    view.setUint32(offsets.typeOffset, 26, true);
    view.setUint32(offsets.flagsOffset, 0x1000, true);
  }
  storage.set(new TextEncoder().encode("apfs"), offsets.typeNameOffset);
  return storage;
}
