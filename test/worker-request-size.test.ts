import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_IMPORT_BYTES,
  MAX_JSON_BODY_BYTES,
  MAX_STORED_TITLE_CHARS
} from "../shared/types.js";
import {
  PRE_ASIDE_REPROMPT_WORKER_PROTOCOL_VERSION,
  PRE_FACT_STATES_WORKER_PROTOCOL_VERSION,
  PRE_ASIDE_WORKER_PROTOCOL_VERSION,
  PRE_DIAGNOSTIC_WORKER_PROTOCOL_VERSION,
  PRE_PROVIDER_RECOVERY_WORKER_PROTOCOL_VERSION,
  PRE_SETTINGS_SCHEMA5_WORKER_PROTOCOL_VERSION,
  PREDECESSOR_WORKER_PROTOCOL_VERSION,
  WORKER_PROTOCOL_VERSION
} from "../shared/worker-protocol.js";
import { ServiceError } from "../server/errors.js";
import { parseWorkerMutation } from "../server/worker-mutations.js";
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

test("protocol-v10 mutation inputs survive the Aside protocol bump", () => {
  const id = {
    workerInstanceId: "c".repeat(32),
    sequence: 1n
  };
  const parsed = parseWorkerRequest({
    method: "renameStory",
    input: { id: "story", title: "Title" },
    protocolVersion: PRE_ASIDE_WORKER_PROTOCOL_VERSION,
    mutationId: "m1.1767225600000.2123456789abcdef0123456789abcdef",
    deadlineMs: Date.now() + 60_000
  }, id);

  assert.equal(parsed.protocolVersion, PRE_ASIDE_WORKER_PROTOCOL_VERSION);
  assert.equal(WORKER_PROTOCOL_VERSION, PRE_FACT_STATES_WORKER_PROTOCOL_VERSION + 1);
});

test("pre-v14 Aside retakes retain the prior request shape", () => {
  const input = {
    storyId: "story",
    sessionId: "session",
    turnIndex: 0,
    anchor: null
  };

  assert.doesNotThrow(() => validateWorkerRequestSize(
    "retakeAside",
    input,
    PRE_ASIDE_REPROMPT_WORKER_PROTOCOL_VERSION
  ));
  assert.deepEqual(
    parseWorkerMutation(
      "retakeAside",
      input,
      PRE_ASIDE_REPROMPT_WORKER_PROTOCOL_VERSION
    ),
    input
  );
  for (const protocolVersion of [
    PRE_SETTINGS_SCHEMA5_WORKER_PROTOCOL_VERSION,
    PRE_ASIDE_REPROMPT_WORKER_PROTOCOL_VERSION
  ]) {
    assert.throws(
      () => validateWorkerRequestSize(
        "retakeAside",
        { ...input, question: "New prompt" },
        protocolVersion
      ),
      (error: unknown) => error instanceof ServiceError && error.status === 400
    );
    assert.throws(
      () => parseWorkerMutation(
        "retakeAside",
        { ...input, question: "New prompt" },
        protocolVersion
      ),
      (error: unknown) => error instanceof ServiceError && error.status === 400
    );
  }
  assert.deepEqual(
    parseWorkerMutation(
      "retakeAside",
      { ...input, question: "New prompt" },
      WORKER_PROTOCOL_VERSION
    ),
    { ...input, question: "New prompt" }
  );
});

test("worker message parser admits the v2 Aside mutation methods", () => {
  const id = {
    workerInstanceId: "e".repeat(32),
    sequence: 1n
  };
  for (const [method, input, mutationId] of [
    [
      "asideSessionMutation",
      {
        storyId: "story",
        operation: "clear",
        sessionId: "session",
        anchor: null
      },
      "m1.1767225600000.3123456789abcdef0123456789abcdef"
    ],
    [
      "retakeAside",
      {
        storyId: "story",
        sessionId: "session",
        turnIndex: 0,
        anchor: null
      },
      "m1.1767225600000.4123456789abcdef0123456789abcdef"
    ]
  ] as const) {
    const parsed = parseWorkerRequest({
      method,
      input,
      protocolVersion: WORKER_PROTOCOL_VERSION,
      mutationId,
      deadlineMs: Date.now() + 60_000
    }, id);
    assert.equal(parsed.method, method);
    assert.deepEqual(parsed.input, input);
  }
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

test("worker NovelAI import validates request size bounds", () => {
  assert.doesNotThrow(() => validateWorkerRequestSize("importNovelAI", {
    storyContainerJson: "x".repeat(100)
  }));
  assert.throws(
    () => validateWorkerRequestSize("importNovelAI", {
      storyContainerJson: "x".repeat(MAX_IMPORT_BYTES + 1)
    }),
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

test("Aside v2 worker methods measure their logical HTTP bodies", () => {
  const routeOnlyStoryId = "route fields are not an HTTP body";
  const oversizedSessionId = "x".repeat(MAX_JSON_BODY_BYTES);

  assert.doesNotThrow(() => validateWorkerRequestSize("asideSessionMutation", {
    storyId: routeOnlyStoryId,
    operation: "clear",
    sessionId: "session",
    anchor: null
  }));
  assert.throws(
    () => validateWorkerRequestSize("asideSessionMutation", {
      storyId: "story",
      operation: "clear",
      sessionId: oversizedSessionId,
      anchor: null
    }),
    (error: unknown) => error instanceof ServiceError && error.status === 413
  );

  assert.doesNotThrow(() => validateWorkerRequestSize("retakeAside", {
    storyId: routeOnlyStoryId,
    sessionId: "session",
    turnIndex: 0,
    anchor: null
  }));
  assert.throws(
    () => validateWorkerRequestSize("retakeAside", {
      storyId: "story",
      sessionId: oversizedSessionId,
      turnIndex: 0,
      anchor: null
    }),
    (error: unknown) => error instanceof ServiceError && error.status === 413
  );

  const retakeBodyBytes = bytes(JSON.stringify({
    sessionId: "session",
    turnIndex: 0,
    anchor: null,
    question: ""
  }));
  const question = "x".repeat(MAX_JSON_BODY_BYTES - retakeBodyBytes);
  assert.doesNotThrow(() => validateWorkerRequestSize("retakeAside", {
    storyId: routeOnlyStoryId,
    sessionId: "session",
    turnIndex: 0,
    anchor: null,
    question
  }));
  assert.throws(
    () => validateWorkerRequestSize("retakeAside", {
      storyId: routeOnlyStoryId,
      sessionId: "session",
      turnIndex: 0,
      anchor: null,
      question: `${question}x`
    }),
    (error: unknown) => error instanceof ServiceError && error.status === 413
  );
});

test("partial rewrite settlement sends only fixed-size stream identity", () => {
  assert.doesNotThrow(() => validateWorkerRequestSize(
    "commitPartialRewrite",
    {
      storyId: "story",
      nodeId: "node",
      attemptId: "attempt",
      streamedDigest: "a".repeat(64)
    }
  ));
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
