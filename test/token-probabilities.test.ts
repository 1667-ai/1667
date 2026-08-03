import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { SamplingContext } from "../shared/sampling-capabilities.js";
import {
  resolveTokenProbabilities,
  tokenProbabilityUnavailableReason,
  tokenProbabilityUnavailableReasonCompact,
  type TokenProbabilityResolution,
  type TokenProbabilityUnavailableReason
} from "../shared/token-probability-capabilities.js";
import {
  MAX_ALTERNATIVE_TOKENS,
  MAX_TOKEN_PROBABILITY_BYTES,
  MAX_TOKEN_PROBABILITY_STEPS,
  MAX_TOKEN_PROBABILITY_TEXT_CHARS,
  TokenProbabilityFormatError,
  alignTokenProbabilities,
  createTokenProbabilities,
  parseTokenProbabilities,
  probabilityOf,
  serializeTokenProbabilities,
  type TokenProbabilityRecord,
  type TokenProbabilityStep
} from "../shared/token-probabilities.js";

// --- resolveTokenProbabilities: every documented preset/protocol/refusal outcome ---

interface ResolutionFixture {
  readonly name: string;
  readonly context: SamplingContext;
  readonly refused?: boolean;
  readonly expected: TokenProbabilityResolution;
}

const RESOLUTION_FIXTURES: readonly ResolutionFixture[] = [
  { name: "legacy-v1 protocol and preset", context: context("legacy-v1", "legacy-v1"), expected: unavailable("legacy-v1") },
  { name: "legacy-v1 protocol, non-legacy preset", context: context("legacy-v1", "openai"), expected: unavailable("legacy-v1") },
  { name: "legacy-v1 preset, non-legacy protocol", context: context("openai-chat-completions", "legacy-v1"), expected: unavailable("legacy-v1") },
  {
    name: "legacy-v1 wins over a refused model",
    context: context("legacy-v1", "legacy-v1"),
    refused: true,
    expected: unavailable("legacy-v1")
  },
  { name: "dry-run protocol and preset", context: context("dry-run", "dry-run"), expected: available("dry-run") },
  {
    name: "OpenAI protocol with dry-run preset",
    context: context("openai-chat-completions", "dry-run"),
    expected: available("dry-run")
  },
  {
    name: "a refused model wins over dry-run availability",
    context: context("dry-run", "dry-run"),
    refused: true,
    expected: unavailable("model-refused")
  },
  { name: "Anthropic Messages protocol", context: context("anthropic-messages", "anthropic"), expected: unavailable("protocol") },
  { name: "OpenAI preset", context: context("openai-chat-completions", "openai"), expected: available("openai-logprobs") },
  {
    name: "a refused OpenAI model",
    context: context("openai-chat-completions", "openai"),
    refused: true,
    expected: unavailable("model-refused")
  },
  { name: "OpenRouter preset", context: context("openai-chat-completions", "openrouter"), expected: available("openai-logprobs") },
  { name: "llama.cpp preset", context: context("openai-chat-completions", "llama-cpp"), expected: available("openai-logprobs") },
  { name: "KoboldCpp preset", context: context("openai-chat-completions", "koboldcpp"), expected: available("openai-logprobs") },
  { name: "LM Studio preset", context: context("openai-chat-completions", "lm-studio"), expected: available("openai-logprobs") },
  { name: "Ollama preset", context: context("openai-chat-completions", "ollama"), expected: unavailable("preset-unknown") },
  { name: "custom preset", context: context("openai-chat-completions", "custom"), expected: unavailable("preset-unknown") }
];

for (const fixture of RESOLUTION_FIXTURES) {
  test(`resolveTokenProbabilities: ${fixture.name}`, () => {
    assert.deepEqual(resolveTokenProbabilities(fixture.context, fixture.refused), fixture.expected);
  });
}

test("presentation text matches the documented wording for every unavailable reason", () => {
  assert.equal(tokenProbabilityUnavailableReason("legacy-v1"), "Format 1 settings are read-only.");
  assert.equal(tokenProbabilityUnavailableReasonCompact("legacy-v1"), "read-only");
  assert.equal(tokenProbabilityUnavailableReason("protocol"), "This protocol does not document token probabilities.");
  assert.equal(tokenProbabilityUnavailableReasonCompact("protocol"), "not in protocol");
  assert.equal(
    tokenProbabilityUnavailableReason("preset-unknown"),
    "This endpoint does not document token probabilities."
  );
  assert.equal(tokenProbabilityUnavailableReasonCompact("preset-unknown"), "unknown endpoint");
  assert.equal(tokenProbabilityUnavailableReason("model-refused"), "This model refused token probabilities.");
  assert.equal(tokenProbabilityUnavailableReasonCompact("model-refused"), "model refused");
});

function context(protocol: SamplingContext["protocol"], preset: SamplingContext["preset"]): SamplingContext {
  return { protocol, preset, remoteModelId: "fixture-model", temperatureSupport: "unknown" };
}

function available(wire: "openai-logprobs" | "dry-run"): TokenProbabilityResolution {
  return { kind: "available", wire };
}

function unavailable(reason: TokenProbabilityUnavailableReason): TokenProbabilityResolution {
  return { kind: "unavailable", reason };
}

// --- probabilityOf: the design's own reference numbers ---

test("probabilityOf matches the design's reference values to three decimal places", () => {
  assert.equal(probabilityOf(-0.887).toFixed(3), "0.412");
  assert.equal(probabilityOf(-1.605).toFixed(3), "0.201");
  assert.equal(probabilityOf(-4.074).toFixed(3), "0.017");
});

test("probabilityOf clamps to [0, 1]", () => {
  assert.equal(probabilityOf(0), 1);
  assert.equal(probabilityOf(-1_000), 0);
});

// --- serialize / parse: byte-stable round trip ---

function sampleRecord(): TokenProbabilityRecord {
  return createTokenProbabilities(3, [
    {
      token: "pit",
      logprob: -0.887,
      alternatives: [
        { token: "pit", logprob: -0.887 },
        { token: "dark", logprob: -1.605 },
        { token: "well", logprob: -4.074 }
      ]
    }
  ], undefined, 0);
}

test("a record round-trips through serialize/parse byte-for-byte", () => {
  const record = sampleRecord();
  const text = serializeTokenProbabilities(record);
  const parsed = parseTokenProbabilities(text);
  assert.deepEqual(parsed, record);
  assert.equal(serializeTokenProbabilities(parsed), text);
});

test("a truncated record keeps the flag through a round trip and only then", () => {
  const truncated = createTokenProbabilities(1, [{ token: "a", logprob: -0.1, alternatives: [] }], true, 0);
  const truncatedText = serializeTokenProbabilities(truncated);
  assert.match(truncatedText, /"truncated":true/);
  assert.deepEqual(parseTokenProbabilities(truncatedText), truncated);

  const untruncatedText = serializeTokenProbabilities(sampleRecord());
  assert.equal(untruncatedText.includes("truncated"), false);
});

test("parseTokenProbabilities verifies an expected hash and rejects a mismatch", () => {
  const text = serializeTokenProbabilities(sampleRecord());
  const hash = createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
  assert.deepEqual(parseTokenProbabilities(text, hash), sampleRecord());
  assert.throws(() => parseTokenProbabilities(text, "a".repeat(64)), TokenProbabilityFormatError);
  assert.throws(() => parseTokenProbabilities(text, "not-a-hash"), TokenProbabilityFormatError);
});

test("parse rejects a payload that is not already canonical bytes", () => {
  const text = serializeTokenProbabilities(sampleRecord());
  assert.throws(() => parseTokenProbabilities(`${text} `), /canonically serialized/);
});

// --- bounds: enforced on build (createTokenProbabilities) and on parse ---

function baseWire(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    format: "1667-token-probabilities",
    schemaVersion: 1,
    requested: 3,
    textOffset: 0,
    steps: [
      {
        token: "pit",
        logprob: -0.887,
        alternatives: [{ token: "pit", logprob: -0.887 }]
      }
    ],
    ...overrides
  });
}

test("build and parse reject a step count over the limit", () => {
  const step: TokenProbabilityStep = { token: "x", logprob: -0.1, alternatives: [] };
  const steps = Array.from({ length: MAX_TOKEN_PROBABILITY_STEPS + 1 }, () => step);
  assert.throws(() => createTokenProbabilities(1, steps, undefined, 0), /step limit/);
  assert.throws(() => parseTokenProbabilities(baseWire({ steps })), /step limit/);
});

test("build and parse reject an alternative count over the limit on one step", () => {
  const alternatives = Array.from({ length: MAX_ALTERNATIVE_TOKENS + 1 }, () => ({ token: "x", logprob: -0.1 }));
  const steps = [{ token: "pit", logprob: -0.1, alternatives }];
  assert.throws(() => createTokenProbabilities(1, steps, undefined, 0), /alternative limit/);
  assert.throws(() => parseTokenProbabilities(baseWire({ steps })), /alternative limit/);
});

test("build and parse reject a token past the character limit", () => {
  const longToken = "x".repeat(MAX_TOKEN_PROBABILITY_TEXT_CHARS + 1);
  const steps = [{ token: longToken, logprob: -0.1, alternatives: [] }];
  assert.throws(() => createTokenProbabilities(1, steps, undefined, 0), /character limit/);
  assert.throws(() => parseTokenProbabilities(baseWire({ steps })), /character limit/);
});

test("build and parse reject an unpaired surrogate in a token", () => {
  const steps = [{ token: "\ud800", logprob: -0.1, alternatives: [] }];
  assert.throws(() => createTokenProbabilities(1, steps, undefined, 0), /surrogate/);
  assert.throws(() => parseTokenProbabilities(baseWire({ steps })), /surrogate/);
});

test("build rejects a positive or non-finite logprob", () => {
  assert.throws(
    () => createTokenProbabilities(1, [{ token: "x", logprob: 0.1, alternatives: [] }], undefined, 0),
    /logprob/
  );
  assert.throws(
    () => createTokenProbabilities(1, [{ token: "x", logprob: Number.NaN, alternatives: [] }], undefined, 0),
    /logprob/
  );
  assert.throws(
    () => createTokenProbabilities(1, [{ token: "x", logprob: Number.POSITIVE_INFINITY, alternatives: [] }], undefined, 0),
    /logprob/
  );
});

test("build rejects a negative or non-integer textOffset", () => {
  const steps = [{ token: "x", logprob: -0.1, alternatives: [] }];
  assert.throws(() => createTokenProbabilities(1, steps, undefined, -1), /textOffset/);
  assert.throws(() => createTokenProbabilities(1, steps, undefined, 1.5), /textOffset/);
});

test("parse rejects a positive or non-finite logprob", () => {
  // JSON has no NaN/Infinity literal, but an oversized exponent parses to one.
  const positive = baseWire().replace('"logprob":-0.887', '"logprob":0.887');
  assert.throws(() => parseTokenProbabilities(positive), /logprob/);
  const nonFinite = baseWire().replace('"logprob":-0.887', '"logprob":-1e400');
  assert.throws(() => parseTokenProbabilities(nonFinite), /logprob/);
});

test("build and parse reject a requested count out of 1..MAX_ALTERNATIVE_TOKENS", () => {
  assert.throws(() => createTokenProbabilities(0, [], undefined, 0), /requested/);
  assert.throws(() => createTokenProbabilities(MAX_ALTERNATIVE_TOKENS + 1, [], undefined, 0), /requested/);
  assert.throws(() => parseTokenProbabilities(baseWire({ requested: 0, steps: [] })), /requested/);
  assert.throws(
    () => parseTokenProbabilities(baseWire({ requested: MAX_ALTERNATIVE_TOKENS + 1, steps: [] })),
    /requested/
  );
});

test("build rejects an encoded size over the byte limit", () => {
  // Every individual bound (steps, alternatives per step, characters per
  // token) stays within its own limit; only the aggregate crosses 4 MiB, so
  // this isolates the byte bound from every other one.
  const longToken = "x".repeat(MAX_TOKEN_PROBABILITY_TEXT_CHARS);
  const alternatives = Array.from({ length: 5 }, () => ({ token: longToken, logprob: -0.1 }));
  const steps = Array.from({ length: 3_000 }, () => ({ token: longToken, logprob: -0.1, alternatives }));
  assert.throws(() => createTokenProbabilities(20, steps, undefined, 0), /byte size limit/);
});

test("parse rejects a payload over the byte limit before decoding it", () => {
  const raw = "x".repeat(MAX_TOKEN_PROBABILITY_BYTES + 1);
  assert.throws(() => parseTokenProbabilities(raw), /byte size limit/);
});

test("parse rejects a wrong format or schema version", () => {
  assert.throws(() => parseTokenProbabilities(baseWire({ format: "nope" })), /format/);
  assert.throws(() => parseTokenProbabilities(baseWire({ schemaVersion: 2 })), /schema version/);
});

test("parse rejects an unknown or missing key at every level", () => {
  assert.throws(() => parseTokenProbabilities(baseWire({ extra: true })), /unknown key/);
  const { requested: _requested, ...withoutRequested } = JSON.parse(baseWire()) as Record<string, unknown>;
  assert.throws(() => parseTokenProbabilities(JSON.stringify(withoutRequested)), /missing required key/);
  const { textOffset: _textOffset, ...withoutTextOffset } = JSON.parse(baseWire()) as Record<string, unknown>;
  assert.throws(() => parseTokenProbabilities(JSON.stringify(withoutTextOffset)), /missing required key/);
  assert.throws(() => parseTokenProbabilities(baseWire({
    steps: [{ token: "pit", logprob: -0.1, alternatives: [], extra: true }]
  })), /unknown key/);
  assert.throws(() => parseTokenProbabilities(baseWire({
    steps: [{ token: "pit", logprob: -0.1, alternatives: [{ token: "pit", logprob: -0.1, extra: true }] }]
  })), /unknown key/);
});

test("parse rejects a truncated value other than true", () => {
  assert.throws(() => parseTokenProbabilities(baseWire({ truncated: false })), /truncated/);
});

test("build and parse reject a negative or non-integer textOffset", () => {
  assert.throws(() => parseTokenProbabilities(baseWire({ textOffset: -1 })), /textOffset/);
  assert.throws(() => parseTokenProbabilities(baseWire({ textOffset: 1.5 })), /textOffset/);
  assert.throws(() => parseTokenProbabilities(baseWire({ textOffset: "0" })), /textOffset/);
});

test("a record with a non-zero textOffset round-trips byte-for-byte, key ordered right after requested", () => {
  const record = createTokenProbabilities(3, [
    { token: "pit", logprob: -0.887, alternatives: [] }
  ], undefined, 42);
  const text = serializeTokenProbabilities(record);
  assert.match(text, /"requested":3,"textOffset":42,"steps":/);
  assert.deepEqual(parseTokenProbabilities(text), record);
});

// --- alignTokenProbabilities: the one piece of pure logic no end-to-end test
// pins down every branch of (issue #291 addendum) ---

function step(token: string): TokenProbabilityStep {
  return { token, logprob: -0.1, alternatives: [] };
}

test("alignTokenProbabilities: an exact match keeps every step at segmentStart", () => {
  const steps = [step("pit"), step(" of vezh")];
  const aligned = alignTokenProbabilities(steps, "pit of vezh", 100);
  assert.deepEqual(aligned, { steps, textOffset: 100 });
});

test("alignTokenProbabilities: a truncated recording (a prefix of the segment) keeps every step, offset by the match", () => {
  // The captured steps cover only the start of a longer stored segment —
  // what a bound stopping the recording short would produce.
  const steps = [step("pit"), step(" of")];
  const aligned = alignTokenProbabilities(steps, "the pit of vezh", 0);
  assert.deepEqual(aligned, { steps, textOffset: 4 });
});

test("alignTokenProbabilities: a leading trim drops the steps before the match, on a token boundary", () => {
  // A new take stores raw.trim(); a leading-whitespace step recorded for the
  // untrimmed raw is dropped, and the offset stays at segmentStart because
  // trimming does not change where the take's own text begins.
  const steps = [step(" "), step("The"), step(" pit")];
  const aligned = alignTokenProbabilities(steps, "The pit", 0);
  assert.deepEqual(aligned, { steps: [step("The"), step(" pit")], textOffset: 0 });
});

test("alignTokenProbabilities: a stripped echo drops the anchor's steps the same way a trim does", () => {
  // AnchoredOutputFilter strips the echoed left anchor from `raw`; the
  // captured steps still include it, so this is the trim branch again, just
  // with a non-empty prefix instead of whitespace.
  const steps = [step("into the"), step(" pit")];
  const aligned = alignTokenProbabilities(steps, " pit", 40);
  assert.deepEqual(aligned, { steps: [step(" pit")], textOffset: 40 });
});

test("alignTokenProbabilities: a trailing trim drops the steps at or after the match end", () => {
  const steps = [step("The"), step(" pit"), step(" yawned")];
  const aligned = alignTokenProbabilities(steps, "The pit", 0);
  assert.deepEqual(aligned, { steps: [step("The"), step(" pit")], textOffset: 0 });
});

test("alignTokenProbabilities: a leading whitespace-only boundary narrows the token instead of refusing", () => {
  // A new take stores raw.trim(), so a real provider's first recorded token —
  // " Hello" — routinely carries leading whitespace the stored text does
  // not. The cut falls inside that token, not between two, but what it
  // excludes is pure whitespace, so the step is kept, narrowed.
  const steps = [step(" Hello"), step(" world")];
  const aligned = alignTokenProbabilities(steps, "Hello world", 0);
  assert.deepEqual(aligned, {
    steps: [{ token: "Hello", logprob: -0.1, alternatives: [] }, step(" world")],
    textOffset: 0
  });
  assert.equal(aligned?.steps.map((s) => s.token).join(""), "Hello world");
});

test("alignTokenProbabilities: a trailing whitespace-only boundary narrows the token instead of refusing", () => {
  const steps = [step("Hello"), step(" world ")];
  const aligned = alignTokenProbabilities(steps, "Hello world", 0);
  assert.deepEqual(aligned, {
    steps: [step("Hello"), { token: " world", logprob: -0.1, alternatives: [] }],
    textOffset: 0
  });
  assert.equal(aligned?.steps.map((s) => s.token).join(""), "Hello world");
});

test("alignTokenProbabilities: a leading boundary landing inside a token refuses rather than guessing", () => {
  // "X" is not whitespace, so the cut cannot be reconciled as a trim.
  const steps = [step("Xhello"), step(" world")];
  assert.equal(alignTokenProbabilities(steps, "hello world", 0), null);
});

test("alignTokenProbabilities: a boundary landing inside a token refuses rather than guessing", () => {
  // "wor" is not a whole-token prefix of the recorded " world" step — the cut
  // falls mid-token, not between two steps, and what it excludes ("ld") is
  // not whitespace.
  const steps = [step("Hello"), step(" world"), step("!")];
  assert.equal(alignTokenProbabilities(steps, "Hello wor", 0), null);
});

test("alignTokenProbabilities: a boundary that would leave a token empty drops that step instead", () => {
  // The empty step sits strictly inside the match window — past the leading
  // boundary, short of the trailing one — so it is neither a truncation
  // fully outside the match nor a boundary token to narrow: narrowing it
  // would leave nothing, so it is dropped, and the steps around it still
  // concatenate to exactly the stored segment.
  const steps = [step(" Hello"), step(""), step(" world")];
  const aligned = alignTokenProbabilities(steps, "Hello world", 0);
  assert.deepEqual(aligned, {
    steps: [{ token: "Hello", logprob: -0.1, alternatives: [] }, step(" world")],
    textOffset: 0
  });
  assert.equal(aligned?.steps.map((s) => s.token).join(""), "Hello world");
});

test("alignTokenProbabilities: no relationship between the recording and the segment refuses", () => {
  const steps = [step("pit"), step(" of vezh")];
  assert.equal(alignTokenProbabilities(steps, "an entirely different passage", 0), null);
});

test("alignTokenProbabilities: an empty recording or an empty segment refuses", () => {
  assert.equal(alignTokenProbabilities([], "pit of vezh", 0), null);
  assert.equal(alignTokenProbabilities([step("pit")], "", 0), null);
});
