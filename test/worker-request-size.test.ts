import assert from "node:assert/strict";
import test from "node:test";
import { MAX_IMPORT_BYTES, MAX_JSON_BODY_BYTES } from "../shared/types.js";
import {
  PREDECESSOR_WORKER_PROTOCOL_VERSION,
  WORKER_PROTOCOL_VERSION
} from "../shared/worker-protocol.js";
import { ServiceError } from "../server/errors.js";
import { validateWorkerRequestSize } from "../server/worker-request-size.js";

const bytes = (value: string): number => Buffer.byteLength(value, "utf8");

test("worker import measures raw JSONL bytes rather than escaped protocol bytes", () => {
  const escapedCharacters = 150_000;
  const empty = JSON.stringify({ is_user: false, mes: "" });
  const prose = "\\".repeat(escapedCharacters)
    + "x".repeat(MAX_IMPORT_BYTES - bytes(empty) - escapedCharacters * 2);
  const jsonl = JSON.stringify({ is_user: false, mes: prose });

  assert.equal(bytes(jsonl), MAX_IMPORT_BYTES);
  assert.ok(bytes(JSON.stringify({ jsonl })) > MAX_IMPORT_BYTES + 100_000);
  assert.doesNotThrow(() => validateWorkerRequestSize("importSillyTavern", { jsonl }));
  assert.throws(
    () => validateWorkerRequestSize("importSillyTavern", { jsonl: `${jsonl}x` }),
    (error: unknown) => error instanceof ServiceError && error.status === 413
  );
});

test("worker JSON methods measure their HTTP-equivalent body", () => {
  const empty = bytes(JSON.stringify({ text: "" }));
  const text = "x".repeat(MAX_JSON_BODY_BYTES - empty);
  const input = { storyId: "route fields are not an HTTP body", body: { text } };

  assert.doesNotThrow(() => validateWorkerRequestSize("createNode", input));
  assert.throws(
    () => validateWorkerRequestSize("createNode", { ...input, body: { text: `${text}x` } }),
    (error: unknown) => error instanceof ServiceError && error.status === 413
  );
});

test("chapter removal admission carries only its bounded undo fingerprint", () => {
  const removedFingerprint = "a".repeat(64);
  assert.doesNotThrow(() => validateWorkerRequestSize(
    "removeChapterBreak",
    {
      storyId: "story",
      breakId: "break",
      removedFingerprint
    }
  ));
  assert.ok(
    bytes(JSON.stringify({
      break: { title: "x".repeat(MAX_JSON_BODY_BYTES) },
      summaries: []
    })) > MAX_JSON_BODY_BYTES
  );
});

test("chapter removal sizing follows the selected protocol schema", () => {
  const oversizedRemoved = {
    break: { title: "x".repeat(MAX_JSON_BODY_BYTES) },
    summaries: []
  };
  assert.throws(
    () => validateWorkerRequestSize(
      "removeChapterBreak",
      {
        storyId: "story",
        breakId: "break",
        removed: oversizedRemoved
      },
      PREDECESSOR_WORKER_PROTOCOL_VERSION
    ),
    (error: unknown) => error instanceof ServiceError && error.status === 413
  );
  assert.throws(
    () => validateWorkerRequestSize(
      "removeChapterBreak",
      {
        storyId: "story",
        breakId: "break",
        removed: oversizedRemoved,
        removedFingerprint: "a".repeat(64)
      },
      PREDECESSOR_WORKER_PROTOCOL_VERSION
    ),
    (error: unknown) => error instanceof ServiceError && error.status === 400
  );
  assert.throws(
    () => validateWorkerRequestSize(
      "removeChapterBreak",
      {
        storyId: "story",
        breakId: "break",
        removed: { break: {}, summaries: [] },
        removedFingerprint: "a".repeat(64)
      },
      WORKER_PROTOCOL_VERSION
    ),
    (error: unknown) => error instanceof ServiceError && error.status === 400
  );
});
