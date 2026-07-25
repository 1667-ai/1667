import assert from "node:assert/strict";
import test from "node:test";
import { settingsMutationFailureAction } from "../shared/settings-mutation-failure.js";

test("settings mutation failure policy distinguishes terminal, stale, and uncertain outcomes", () => {
  for (const code of [
    "invalid_request",
    "content_too_large",
    "unprocessable",
    "forbidden",
    "not_found",
    "idempotency_conflict",
    "mutation_expired"
  ]) {
    assert.equal(settingsMutationFailureAction(code), "retire");
  }
  for (const code of [
    "revision_conflict",
    "conflict",
    "settings_edit_requires_data_format_2"
  ]) {
    assert.equal(settingsMutationFailureAction(code), "refresh");
  }
  for (const code of [
    "resource_busy",
    "receipt_storage_unavailable",
    "mutation_outcome_unknown",
    "internal",
    "provider_failure",
    "future_code",
    null
  ]) {
    assert.equal(settingsMutationFailureAction(code), "retain");
  }
});
