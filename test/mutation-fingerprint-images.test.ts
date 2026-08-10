import assert from "node:assert/strict";
import test from "node:test";
import { mutationFingerprint } from "../server/mutation-receipts.js";

/**
 * `mutationFingerprint` canonicalizes the WHOLE `continueStory` worker
 * input, and the input carries an ordered `images` list of `{leaseId,
 * objectId}` pairs. Two different leases naming the SAME Image Object must
 * still fingerprint identically, or a retry that restages the same image
 * under a fresh Draft Lease could never be recognized as the same mutation.
 * See server/mutation-receipts.ts's `fingerprintableWorkerInput`.
 */

const OBJECT_A = "a".repeat(64);
const OBJECT_B = "b".repeat(64);
const LEASE_1 = "1".repeat(64);
const LEASE_2 = "2".repeat(64);

function continueInput(images: readonly { leaseId: string; objectId: string }[]) {
  return {
    storyId: "story-one",
    instruction: "Continue.",
    genId: "gen-1",
    target: { parentId: "part-1" },
    images
  };
}

test("two Draft Leases naming the same Image Object give one fingerprint", () => {
  const first = mutationFingerprint(
    "continueStory",
    continueInput([{ leaseId: LEASE_1, objectId: OBJECT_A }])
  );
  const second = mutationFingerprint(
    "continueStory",
    continueInput([{ leaseId: LEASE_2, objectId: OBJECT_A }])
  );
  assert.equal(first, second, "the lease id must not affect the fingerprint");
});

test("a different Image Object id still changes the fingerprint", () => {
  const withA = mutationFingerprint(
    "continueStory",
    continueInput([{ leaseId: LEASE_1, objectId: OBJECT_A }])
  );
  const withB = mutationFingerprint(
    "continueStory",
    continueInput([{ leaseId: LEASE_1, objectId: OBJECT_B }])
  );
  assert.notEqual(withA, withB, "a genuinely different image must still change the fingerprint");
});

test("a text-only continueStory input with no images field fingerprints deterministically, untouched by the transform", () => {
  const input = {
    storyId: "story-one",
    instruction: "Continue.",
    genId: "gen-1",
    target: { parentId: "part-1" }
  };
  assert.equal(
    mutationFingerprint("continueStory", input),
    mutationFingerprint("continueStory", { ...input }),
    "the same text-only input must fingerprint the same way every time"
  );
});

test("image order still matters: the same two objects in a different order fingerprint differently", () => {
  const forward = mutationFingerprint(
    "continueStory",
    continueInput([
      { leaseId: LEASE_1, objectId: OBJECT_A },
      { leaseId: LEASE_2, objectId: OBJECT_B }
    ])
  );
  const backward = mutationFingerprint(
    "continueStory",
    continueInput([
      { leaseId: LEASE_2, objectId: OBJECT_B },
      { leaseId: LEASE_1, objectId: OBJECT_A }
    ])
  );
  assert.notEqual(forward, backward, "the ordered list is part of the provider-semantic input");
});

test("the lease-stripping transform only ever applies to continueStory", () => {
  // A different method's input that happens to carry an `images` field
  // (never a real shape, but this proves the transform is method-gated, not
  // a blanket "images" key match) must not have it touched.
  const untouched = mutationFingerprint("renameStory", { images: [{ leaseId: LEASE_1, objectId: OBJECT_A }] });
  const withDifferentLease = mutationFingerprint("renameStory", { images: [{ leaseId: LEASE_2, objectId: OBJECT_A }] });
  assert.notEqual(untouched, withDifferentLease, "only continueStory strips lease ids before fingerprinting");
});
