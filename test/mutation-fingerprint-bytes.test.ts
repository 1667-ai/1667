import assert from "node:assert/strict";
import test from "node:test";
import { mutationFingerprint } from "../server/mutation-receipts.js";

/** An import carries its whole file through the mutation boundary, and the
 * fingerprint is taken before any import limit is read. Canonical JSON has no
 * typed-array case, so an un-digested Uint8Array becomes one sorted string key
 * per byte: at the 20 MB file cap that is twenty million keys and hundreds of
 * megabytes of string, which a caller can trigger at will. */
test("fingerprinting a file-sized byte array stays cheap", () => {
  const twentyMegabytes = new Uint8Array(20_000_000);

  const started = Date.now();
  mutationFingerprint("importCard", { storyId: "story", cardBytes: twentyMegabytes });
  const elapsed = Date.now() - started;

  // Enumerating the bytes takes seconds and allocates hundreds of megabytes.
  // The bound is generous so a slow machine does not fail the suite; it is two
  // orders of magnitude below the behaviour it guards against.
  assert.ok(elapsed < 1_000, `fingerprint took ${elapsed}ms`);
});

test("a digested byte array still identifies its own bytes", () => {
  const fingerprint = (bytes: Uint8Array): string =>
    mutationFingerprint("importLorebook", { storyId: "story", archiveBytes: bytes });

  assert.equal(
    fingerprint(Uint8Array.from([1, 2, 3])),
    fingerprint(Uint8Array.from([1, 2, 3])),
    "the same bytes must give the same fingerprint"
  );
  assert.notEqual(
    fingerprint(Uint8Array.from([1, 2, 3])),
    fingerprint(Uint8Array.from([1, 2, 4])),
    "different bytes must give different fingerprints"
  );
  assert.notEqual(
    fingerprint(Uint8Array.from([1, 2, 3])),
    fingerprint(Uint8Array.from([1, 2, 3, 0])),
    "a longer run of bytes must give a different fingerprint"
  );
});
