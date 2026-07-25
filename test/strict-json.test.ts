import assert from "node:assert/strict";
import test from "node:test";
import {
  StrictJsonError,
  parseJsonRejectingDuplicateKeys
} from "../shared/strict-json.js";

test("strict JSON preserves JSON values and rejects decoded duplicate keys", () => {
  const value = parseJsonRejectingDuplicateKeys(
    '{"plain":1,"array":[true,false,null],"nested":{"value":"ok"}}'
  ) as Record<string, unknown>;
  assert.equal(value.plain, 1);
  assert.deepEqual(value.array, [true, false, null]);
  assert.equal(
    (value.nested as Record<string, unknown>).value,
    "ok"
  );
  assert.throws(
    () => parseJsonRejectingDuplicateKeys('{"same":1,"\\u0073ame":2}'),
    StrictJsonError
  );
});

test("strict JSON applies the nesting bound to empty and populated containers", () => {
  const withinBound = `${"[".repeat(128)}0${"]".repeat(128)}`;
  assert.doesNotThrow(() => parseJsonRejectingDuplicateKeys(withinBound));

  for (const tooDeep of [
    `${"[".repeat(129)}0${"]".repeat(129)}`,
    `${"[".repeat(129)}${"]".repeat(129)}`
  ]) {
    assert.throws(
      () => parseJsonRejectingDuplicateKeys(tooDeep),
      /nesting exceeds 128/
    );
  }
});
