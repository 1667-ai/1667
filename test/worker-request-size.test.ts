import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_IMPORT_BYTES,
  MAX_JSON_BODY_BYTES,
  MAX_STORED_TITLE_CHARS
} from "../shared/types.js";
import {
  PRE_DIAGNOSTIC_WORKER_PROTOCOL_VERSION,
  PRE_PROVIDER_RECOVERY_WORKER_PROTOCOL_VERSION,
  PREDECESSOR_WORKER_PROTOCOL_VERSION,
  WORKER_PROTOCOL_VERSION
} from "../shared/worker-protocol.js";
import { ServiceError } from "../server/errors.js";
import { validateWorkerRequestSize } from "../server/worker-request-size.js";
import { parseWorkerRequest } from "../server/worker-message.js";

const bytes = (value: string): number => Buffer.byteLength(value, "utf8");

test("protocol-v6 mutation inputs survive the response-wire version bump", () => {
  const id = {
    workerInstanceId: "a".repeat(32),
    sequence: 1n
  };
  const parsed = parseWorkerRequest({
    method: "renameStory",
    input: { id: "story", title: "Title" },
    protocolVersion: PRE_DIAGNOSTIC_WORKER_PROTOCOL_VERSION,
    mutationId: "m1.1767225600000.0123456789abcdef0123456789abcdef",
    deadlineMs: Date.now() + 60_000
  }, id);

  assert.equal(
    parsed.protocolVersion,
    PRE_DIAGNOSTIC_WORKER_PROTOCOL_VERSION
  );
});

test("protocol-v7 mutation inputs retain the protocol-v6 identity", () => {
  const id = {
    workerInstanceId: "b".repeat(32),
    sequence: 1n
  };
  const parsed = parseWorkerRequest({
    method: "renameStory",
    input: { id: "story", title: "Title" },
    protocolVersion: PRE_PROVIDER_RECOVERY_WORKER_PROTOCOL_VERSION,
    mutationId: "m1.1767225600000.1123456789abcdef0123456789abcdef",
    deadlineMs: Date.now() + 60_000
  }, id);

  assert.equal(
    parsed.protocolVersion,
    PRE_DIAGNOSTIC_WORKER_PROTOCOL_VERSION
  );
});

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

test("worker Markdown import bounds its fallback title before durable publication", () => {
  assert.doesNotThrow(() => validateWorkerRequestSize("importMarkdown", {
    markdown: "prose",
    defaultTitle: "x".repeat(MAX_STORED_TITLE_CHARS)
  }));
  assert.throws(
    () => validateWorkerRequestSize("importMarkdown", {
      markdown: "prose",
      defaultTitle: "x".repeat(MAX_STORED_TITLE_CHARS + 1)
    }),
    (error: unknown) => error instanceof ServiceError && error.status === 413
  );
  assert.doesNotThrow(() => validateWorkerRequestSize("importMarkdown", {
    markdown: "prose",
    defaultTitle: "😀".repeat(MAX_STORED_TITLE_CHARS)
  }));
  assert.throws(
    () => validateWorkerRequestSize("importMarkdown", {
      markdown: "prose",
      defaultTitle: "😀".repeat(MAX_STORED_TITLE_CHARS + 1)
    }),
    (error: unknown) => error instanceof ServiceError && error.status === 413
  );
  assert.throws(
    () => validateWorkerRequestSize("importMarkdown", { markdown: "\uD800" }),
    (error: unknown) => error instanceof ServiceError && error.status === 400
  );
  assert.throws(
    () => validateWorkerRequestSize("importMarkdown", {
      markdown: "prose",
      defaultTitle: "\uD800"
    }),
    (error: unknown) => error instanceof ServiceError && error.status === 400
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
