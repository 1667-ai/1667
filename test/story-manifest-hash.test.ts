import assert from "node:assert/strict";
import test from "node:test";
import {
  hashMutationPreparedRecordBytes,
  hashMutationStartedRecordBytes,
  hashStoryV5ManifestBytes,
  hashStoryV6ManifestBytes
} from "../server/story-manifest-hash.js";

const VECTOR_BYTES = Uint8Array.of(0, 1, 2, 255);

test("story manifest hashes: fixed domain-separated byte vectors", () => {
  assert.equal(
    hashStoryV5ManifestBytes(VECTOR_BYTES),
    "f0f9f789a69a1cd938d72788fbd1341623f8ce02b469d9238e8ac2f985d3aefe"
  );
  assert.equal(
    hashStoryV6ManifestBytes(VECTOR_BYTES),
    "9d1b99be9f985b80f4852760ba603da2cbbeaf34316f93dcce0846fd767368d5"
  );
  assert.equal(
    hashMutationStartedRecordBytes(VECTOR_BYTES),
    "e0221ebdd2e5ff21830066cb86010ed081d89c1ca72d88e065ad935acdb3806e"
  );
  assert.equal(
    hashMutationPreparedRecordBytes(VECTOR_BYTES),
    "4406d839bbda286585a67a19eb19fff725a1c3fd6d47d55ffe192a30d8546afe"
  );
});

test("story manifest hashes: domains differ and exact bytes are authoritative", () => {
  const compact = Buffer.from('{"a":1}', "utf8");
  const spaced = Buffer.from('{ "a": 1 }', "utf8");

  assert.notEqual(hashStoryV5ManifestBytes(compact), hashStoryV6ManifestBytes(compact));
  assert.notEqual(hashStoryV6ManifestBytes(compact), hashStoryV6ManifestBytes(spaced));
  assert.notEqual(hashMutationStartedRecordBytes(compact), hashMutationPreparedRecordBytes(compact));
});
