import assert from "node:assert/strict";
import test from "node:test";
import {
  isProviderMutationId,
  isProviderRecoveryContext
} from "../shared/provider-recovery.js";

test("provider recovery IDs require the true end of the string", () => {
  const mutationId =
    "m1.1767225600001.7123456789abcdef0123456789abcdef";
  assert.equal(isProviderMutationId(mutationId), true);
  assert.equal(isProviderRecoveryContext({
    kind: "target",
    providerMutationId: mutationId
  }), true);

  for (const terminator of ["\n", "\r", "\u2028", "\u2029"]) {
    assert.equal(isProviderMutationId(`${mutationId}${terminator}`), false);
    assert.equal(isProviderRecoveryContext({
      kind: "target",
      providerMutationId: `${mutationId}${terminator}`
    }), false);
  }
});
