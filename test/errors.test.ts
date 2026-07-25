import assert from "node:assert/strict";
import test from "node:test";
import { ProviderError, ServiceError, toPublicServiceError } from "../server/errors.js";

test("public errors normalize provider status identically for every transport", () => {
  assert.deepEqual(toPublicServiceError(new ProviderError("Unauthorized upstream", 401)), {
    code: "provider_failure", message: "Unauthorized upstream", status: 502
  });
  assert.deepEqual(toPublicServiceError(new ServiceError(409, "Changed")), {
    code: "conflict", message: "Changed", status: 409
  });
  assert.deepEqual(toPublicServiceError(new Error("secret")), {
    code: "internal", message: "Internal server error", status: 500
  });
});
