import assert from "node:assert/strict";
import test from "node:test";
import { ServiceError } from "../server/errors.js";
import { validateWorkerRequestSize } from "../server/worker-request-size.js";
import { parseWorkerRequest } from "../server/worker-message.js";
import {
  PRE_SETTINGS_SCHEMA5_WORKER_PROTOCOL_VERSION,
  WORKER_PROTOCOL_VERSION
} from "../shared/worker-protocol.js";
import {
  HTTP_API_PROTOCOL_VERSION,
  HTTP_MAX_CLIENT_PROTOCOL_VERSION,
  HTTP_MIN_CLIENT_PROTOCOL_VERSION
} from "../shared/build-identity.js";
import {
  MAX_PROVIDER_PROBE_REQUEST_BYTES,
  MAX_SETTINGS_SAVE_REQUEST_BYTES
} from "../shared/settings-v5-limits.js";
import { INITIAL_SETTINGS_DOCUMENT_V2 } from "../server/settings-v2-default.js";

test("HTTP protocol 28 refuses servers that ignore Fact States", () => {
  assert.equal(HTTP_API_PROTOCOL_VERSION, 28);
  assert.equal(HTTP_MIN_CLIENT_PROTOCOL_VERSION, 28);
  assert.equal(HTTP_MAX_CLIENT_PROTOCOL_VERSION, 28);
});

test("protocol-11 saveSettings refuses before document decode", () => {
  const command = {
    transportOperationId: "op",
    mutationId: "m1.1767225600000.0123456789abcdef0123456789abcdef",
    expectedStateGeneration: 1,
    document: INITIAL_SETTINGS_DOCUMENT_V2
  };
  assert.throws(
    () => validateWorkerRequestSize(
      "saveSettings",
      { command },
      PRE_SETTINGS_SCHEMA5_WORKER_PROTOCOL_VERSION
    ),
    (error: unknown) => error instanceof ServiceError
      && error.status === 400
      && /saveSettings requires worker protocol 12/u.test(error.message)
  );
  assert.doesNotThrow(() => validateWorkerRequestSize(
    "saveSettings",
    { command },
    WORKER_PROTOCOL_VERSION
  ));
});

test("protocol-11 retained non-settings requests still parse", () => {
  const parsed = parseWorkerRequest({
    method: "renameStory",
    input: { id: "story", title: "Title" },
    protocolVersion: PRE_SETTINGS_SCHEMA5_WORKER_PROTOCOL_VERSION,
    mutationId: "m1.1767225600000.0123456789abcdef0123456789abcdef",
    deadlineMs: Date.now() + 60_000
  }, {
    workerInstanceId: "d".repeat(32),
    sequence: 1n
  });
  assert.equal(parsed.protocolVersion, PRE_SETTINGS_SCHEMA5_WORKER_PROTOCOL_VERSION);
});

test("saveSettings uses the 8 MiB request ceiling", () => {
  assert.equal(MAX_SETTINGS_SAVE_REQUEST_BYTES, 8_388_608);
  const command = {
    transportOperationId: "op",
    mutationId: "m1.1767225600000.0123456789abcdef0123456789abcdef",
    expectedStateGeneration: 1,
    document: INITIAL_SETTINGS_DOCUMENT_V2
  };
  assert.doesNotThrow(() => validateWorkerRequestSize(
    "saveSettings",
    { command },
    WORKER_PROTOCOL_VERSION
  ));
});

test("provider probes keep a 1 MiB request ceiling", () => {
  assert.equal(MAX_PROVIDER_PROBE_REQUEST_BYTES, 1_048_576);
});
