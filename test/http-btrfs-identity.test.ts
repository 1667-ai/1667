import assert from "node:assert/strict";
import test from "node:test";
import {
  readBtrfsIdentityWithIoctl
} from "../server/http-btrfs-identity.js";

test("Btrfs identity uses the retained descriptor and Linux ABIs", () => {
  const requests: bigint[] = [];
  const identity = readBtrfsIdentityWithIoctl(
    73,
    "/proc/self/fd/73",
    (fileDescriptor, request, argument) => {
      requests.push(request);
      assert.equal(fileDescriptor, 73);
      if (request === 0xd000_9412n) {
        assert.equal(argument.byteLength, 4_096);
        assert.equal(argument.readBigUInt64LE(0), 0n);
        assert.equal(argument.readBigUInt64LE(8), 256n);
        argument.writeBigUInt64LE(1_337n, 0);
      } else {
        assert.equal(request, 0x8400_941fn);
        assert.equal(argument.byteLength, 1_024);
        Buffer.from("00112233445566778899aabbccddeeff", "hex")
          .copy(argument, 16);
      }
      return 0;
    }
  );

  assert.deepEqual(requests, [0xd000_9412n, 0x8400_941fn]);
  assert.deepEqual(identity, {
    fileSystemId: "00112233445566778899aabbccddeeff",
    rootId: "1337"
  });
});

test("Btrfs identity rejects failed or empty kernel results", () => {
  assert.throws(
    () => readBtrfsIdentityWithIoctl(9, "/proc/self/fd/9", () => -1),
    /cannot identify the Btrfs filesystem/
  );
  assert.throws(
    () => readBtrfsIdentityWithIoctl(9, "/proc/self/fd/9", () => 0),
    /cannot identify the Btrfs filesystem/
  );
  assert.throws(
    () => readBtrfsIdentityWithIoctl(
      9,
      "/proc/self/fd/9",
      (_fileDescriptor, request, argument) => {
        if (request === 0xd000_9412n) {
          argument.writeBigUInt64LE(256n, 0);
        }
        return 0;
      }
    ),
    /cannot identify the Btrfs filesystem/
  );
});
