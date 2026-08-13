/**
 * Aside admission, history fit, utility route, and object hash.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  canAdmitAsidePair,
  emptyAsideDocument,
  MAX_SIDE_NOTES,
  serializeAsideDocument,
  worstCasePairUtf8Bytes
} from "../shared/aside.js";
import {
  AsideContextAdmissionError,
  asidePlan,
  fitAsideHistory,
  sideNotePairTokens
} from "../shared/aside-plan.js";
import { estimateTokens } from "../shared/tokens.js";
import { selectSettingsRoute } from "../shared/settings-route.js";
import { StoryObjectStore } from "../server/story-objects.js";
import { sha256 } from "../server/story-format.js";
import { FIXED_NOW } from "./story-mutation-fixtures.js";

test("utility route falls back to default when utility is unset", () => {
  const document = {
    schemaVersion: 2 as const,
    connections: {
      c: {
        id: "c",
        name: "c",
        provider: "dry-run" as const,
        baseUrl: "",
        apiKeyEnv: null,
        allowInsecureHttp: false
      }
    },
    models: {
      m: {
        id: "m",
        name: "m",
        connectionId: "c",
        remoteModelId: "dry-run",
        contextWindow: 8_192,
        maxOutputTokens: 1_024
      }
    },
    profiles: {
      default: {
        name: "Default",
        modelId: "m",
        temperature: 0.7,
        maxOutputTokens: 1_024,
        effort: "default" as const,
        cachePolicy: "off" as const
      }
    },
    routing: { default: "default" },
    writing: { defaultAuthorBrief: "" }
  };
  const route = selectSettingsRoute(document as never, "utility");
  assert.equal(route.profileId, "default");
});

test("admission reserves serialized JSON bytes for question and answer", () => {
  const q = "Why does the conflict stall?";
  const reserved = worstCasePairUtf8Bytes(q);
  const expected =
    Buffer.byteLength(JSON.stringify(q), "utf8")
    + 2 + 32_768 * 6
    + Buffer.byteLength('{"question":,"answer":},', "utf8");
  assert.equal(reserved, expected);
  const emptyBytes = Buffer.byteLength(serializeAsideDocument(emptyAsideDocument()), "utf8");
  assert.equal(canAdmitAsidePair(null, q, emptyBytes).ok, true);
});

test("admission accounts for JSON escaping in a submitted question", () => {
  const plain = worstCasePairUtf8Bytes("\\0");
  const escaped = worstCasePairUtf8Bytes('"\\\u0000');
  assert.ok(escaped > plain);
});

test("fitAsideHistory uses tokens and never force-keeps an over-budget newest pair", () => {
  const history = [
    { question: "old-q", answer: "old-a" },
    { question: "new-q", answer: "new-a" }
  ];
  const pair = sideNotePairTokens(history[1]!);
  assert.deepEqual(fitAsideHistory(history, pair - 1), []);
  assert.equal(fitAsideHistory(history, pair).length, 1);
  assert.equal(fitAsideHistory(history, pair * 2).length, 2);
});

test("capacity refusal before provider work when the document is full", () => {
  let notes = emptyAsideDocument();
  for (let i = 0; i < MAX_SIDE_NOTES; i += 1) {
    notes = {
      schemaVersion: 1,
      notes: [...notes.notes, { question: `q${i}`, answer: `a${i}` }]
    };
  }
  const current = Buffer.byteLength(serializeAsideDocument(notes), "utf8");
  const admit = canAdmitAsidePair(notes, "one more?", current);
  assert.equal(admit.ok, false);
  if (!admit.ok) assert.equal(admit.reason, "count");
});

test("Aside document hash matches store object identity", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-aside-hash-"));
  try {
    const objects = new StoryObjectStore(dir);
    await objects.init();
    const document = {
      schemaVersion: 1 as const,
      notes: [{ question: "Hash?", answer: "Identity." }]
    };
    const raw = serializeAsideDocument(document);
    const expected = sha256(Buffer.from(raw, "utf8"));
    const stored = await objects.storeAsideDocument(document);
    assert.equal(stored, expected);
    const loaded = await objects.readAsideDocument(stored);
    assert.equal(loaded.notes[0]!.answer, "Identity.");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("empty-history Aside plan fits a normal context window", () => {
  const node = {
    id: "root",
    parentId: null,
    instruction: "",
    text: "Short prose.",
    model: "m",
    createdAt: FIXED_NOW.toISOString(),
    activeChildId: null
  };
  const plan = asidePlan({
    facts: null,
    parts: [node],
    chapterBreaks: [],
    nodes: [node],
    history: [],
    question: "What tone fits?",
    usableTokens: 8_192 - 1_024
  });
  assert.equal(plan.operation, "aside");
  const total = plan.turns.flatMap((turn) => turn.blocks)
    .reduce((sum, block) => sum + ("text" in block ? estimateTokens(block.text) : 0), 0);
  assert.ok(total < 8_192 - 1_024);
});

test("Aside plan keeps recent history in the input budget after output is capped", () => {
  const node = {
    id: "root",
    parentId: null,
    instruction: "",
    text: "Short prose.",
    model: "m",
    createdAt: FIXED_NOW.toISOString(),
    activeChildId: null
  };
  const question = "What tone fits?";
  const history = [{ question: "What happened?", answer: "The river froze." }];
  const plan = asidePlan({
    facts: null,
    parts: [node],
    chapterBreaks: [],
    nodes: [node],
    history,
    question,
    usableTokens: 8_192 - 1_024
  });
  const text = plan.turns.flatMap((turn) => turn.blocks)
    .map((block) => "text" in block ? block.text : "")
    .join("\n");
  assert.match(text, /What happened\?/u);
  assert.match(text, /The river froze\./u);
});

test("Aside rejects required context before dropping history", () => {
  const node = {
    id: "root",
    parentId: null,
    instruction: "",
    text: "The complete active line.",
    model: "m",
    createdAt: FIXED_NOW.toISOString(),
    activeChildId: null
  };
  assert.throws(
    () => asidePlan({
      facts: "[fact] The established fact.",
      parts: [node],
      chapterBreaks: [],
      nodes: [node],
      history: [{ question: "old", answer: "history" }],
      question: "a".repeat(8_192),
      usableTokens: 1_024
    }),
    (error: unknown) => error instanceof AsideContextAdmissionError
      && error.fixedTokens > error.usableTokens
      && /required Aside context is too large/u.test(error.message)
  );
  const fits = asidePlan({
    facts: "[fact] The established fact.",
    parts: [node],
    chapterBreaks: [],
    nodes: [node],
    history: [{ question: "old", answer: "history" }],
    question: "a".repeat(500),
    usableTokens: 1_024
  });
  const request = fits.turns.at(-1)?.blocks[0];
  assert.ok(request !== undefined && "text" in request);
  assert.match(
    request.text,
    /^a/u
  );
});
