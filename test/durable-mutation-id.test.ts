import assert from "node:assert/strict";
import test from "node:test";
import {
  createDurableMutationId,
  durableMutationTimestampMs,
  isDurableMutationId
} from "../shared/durable-mutation-id.js";
import { requireMutationId } from "../server/mutation-ledger-scalars.js";

test("durable mutation IDs use the frozen timestamp and entropy grammar", () => {
  const id = createDurableMutationId(1_767_225_600_000, {
    getRandomValues(array) {
      (array as Uint8Array).set(Array.from({ length: 16 }, (_, index) => index));
      return array;
    }
  });

  assert.equal(id, "m1.1767225600000.000102030405060708090a0b0c0d0e0f");
  assert.equal(requireMutationId(id), id);
  assert.equal(isDurableMutationId(id), true);
  assert.equal(durableMutationTimestampMs(id), 1_767_225_600_000);
  for (const terminator of ["\n", "\r", "\u2028", "\u2029"]) {
    assert.equal(isDurableMutationId(`${id}${terminator}`), false);
    assert.equal(durableMutationTimestampMs(`${id}${terminator}`), null);
  }
});

test("durable mutation IDs reject timestamps outside the canonical 13-digit range", () => {
  const random = { getRandomValues: (array: Uint8Array) => array };
  assert.throws(() => createDurableMutationId(999_999_999_999, random), /13-digit/);
  assert.throws(() => createDurableMutationId(10_000_000_000_000, random), /13-digit/);
  assert.throws(() => createDurableMutationId(1_767_225_600_000.5, random), /13-digit/);
});
