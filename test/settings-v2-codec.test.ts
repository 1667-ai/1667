import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../server/canonical-json.js";
import {
  ABSENT_SETTINGS_V1,
  ABSENT_SETTINGS_V1_HASH,
  ABSENT_SETTINGS_V1_TEXT,
  formatGenerationSettingsV1,
  parseGenerationSettingsV1Text
} from "../server/settings-v1-codec.js";
import {
  formatSettingsDocumentV2,
  hashSettingsDocumentV2,
  hashSettingsStateV2,
  parseSettingsDocumentV2,
  parseSettingsDocumentV2Bytes,
  parseSettingsDocumentV2Text,
  parseSettingsStateV2Bytes,
  parseSettingsStateV2Text
} from "../server/settings-v2-codec.js";
import {
  applyEffectiveGenerationSettings,
  convertGenerationSettingsV1,
  effectiveGenerationRuntime,
  effectiveGenerationView
} from "../server/settings-v2-conversion.js";
import { createSubscriptionRuntime } from "../server/subscription-runtime.js";
import {
  INITIAL_SETTINGS_DOCUMENT_V2,
  INITIAL_SETTINGS_DOCUMENT_V2_HASH,
  INITIAL_SETTINGS_DOCUMENT_V2_SHA256,
  INITIAL_SETTINGS_DOCUMENT_V2_TEXT,
  INITIAL_SETTINGS_STATE_V2,
  INITIAL_SETTINGS_STATE_V2_HASH,
  INITIAL_SETTINGS_STATE_V2_SHA256,
  INITIAL_SETTINGS_STATE_V2_TEXT
} from "../server/settings-v2-default.js";
import {
  SETTINGS_DOCUMENT_V2_HASH_DOMAIN,
  SETTINGS_STATE_V2_HASH_DOMAIN
} from "../server/settings-v2-hash.js";
import {
  MAX_SETTINGS_DOCUMENT_BYTES,
  MAX_SETTINGS_STATE_BYTES,
  SettingsFormatError
} from "../server/settings-v2-scalars.js";
import { EMPTY_SAMPLING_V2 } from "../shared/settings-v2-types.js";
import {
  SAMPLING_BANNED_STRINGS_POLICY,
  SAMPLING_LOGIT_BIAS_POLICY
} from "../shared/sampling-validation-policy.js";
import { MAX_ALTERNATIVE_TOKENS } from "../shared/token-probabilities.js";
import type { GenerationSettings } from "../shared/types.js";
import {
  SETTINGS_V2_CORPUS_SHA256,
  SETTINGS_V2_HASH_VECTORS_SHA256,
  SETTINGS_V2_SCHEMA_SHA256
} from "../shared/settings-v2-schema-identity.js";
import { assertSettingsV2SchemaCorpus } from "../scripts/settings-v2-schema-validation.js";
import { resolveImageInputCapability } from "../shared/image-input-capabilities.js";
import {
  formatSettingsDocumentV3,
  parseSettingsDocumentV3Text,
  parseSettingsStateV3Text
} from "../server/settings-v3-codec.js";
import { convertSettingsDocumentV2ToV3 } from "../server/settings-v3-conversion.js";
import { validateSettingsDocumentV3 } from "../server/settings-v3-validation.js";
import { INITIAL_SETTINGS_DOCUMENT_V3_TEXT } from "../server/settings-v3-default.js";

interface CorpusCase {
  name: string;
  kind: "document" | "state";
  valid: boolean;
  schemaValid: boolean;
  text: string;
}

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const schemaText = readFileSync(path.join(ROOT, "schema", "settings-v2.schema.json"), "utf8");
const corpusText = readFileSync(path.join(ROOT, "schema", "settings-v2.corpus.json"), "utf8");
const vectorsText = readFileSync(path.join(ROOT, "schema", "settings-v2.hash-vectors.json"), "utf8");
const corpus = JSON.parse(corpusText) as { schemaVersion: number; cases: CorpusCase[] };
const SUBSCRIPTION_RUNTIME = createSubscriptionRuntime(process.cwd());

test("settings schema, corpus, and hash vectors are canonical and identity-pinned", () => {
  const schema = JSON.parse(schemaText) as Record<string, unknown>;
  assert.equal(canonicalJson(schema), schemaText);
  assert.equal(canonicalJson(JSON.parse(corpusText) as unknown), corpusText);
  assert.equal(canonicalJson(JSON.parse(vectorsText) as unknown), vectorsText);
  assert.equal(sha256(schemaText), SETTINGS_V2_SCHEMA_SHA256);
  assert.equal(sha256(corpusText), SETTINGS_V2_CORPUS_SHA256);
  assert.equal(sha256(vectorsText), SETTINGS_V2_HASH_VECTORS_SHA256);
  assert.doesNotThrow(() => assertSettingsV2SchemaCorpus(schema, corpus.cases));
});

for (const fixture of corpus.cases) {
  test(`settings v2 corpus: ${fixture.name}`, () => {
    const parse = corpusFixtureParser(fixture);
    if (fixture.valid) assert.doesNotThrow(() => parse(fixture.text));
    else assert.throws(() => parse(fixture.text));
  });
}

/** Schema 3's corpus cases carry `schemaVersion: 3`; every other case is
 *  schema 2. Peeking the JSON is safe here: only a schema-3 fixture built by
 *  `settingsV2CorpusV3` ever needs the schema-3 codec, and every corpus
 *  fixture's `text` is syntactically valid JSON even when it is schema- or
 *  codec-invalid (a fixture that is not valid JSON at all would fail this
 *  peek the same way `assertSettingsV2SchemaCorpus` treats it: not schema
 *  valid), so falling back to the schema-2 parser on a peek failure matches
 *  this loop's original, schema-2-only behavior. */
function corpusFixtureParser(fixture: CorpusCase): (text: string) => unknown {
  let schemaVersion: unknown;
  try {
    schemaVersion = (JSON.parse(fixture.text) as { schemaVersion?: unknown }).schemaVersion;
  } catch {
    schemaVersion = undefined;
  }
  if (schemaVersion === 3) {
    return fixture.kind === "document" ? parseSettingsDocumentV3Text : parseSettingsStateV3Text;
  }
  return fixture.kind === "document" ? parseSettingsDocumentV2Text : parseSettingsStateV2Text;
}

test("fixed initial document and state bytes have raw and domain-separated hashes", () => {
  assert.equal(formatSettingsDocumentV2(INITIAL_SETTINGS_DOCUMENT_V2), INITIAL_SETTINGS_DOCUMENT_V2_TEXT);
  assert.equal(canonicalJson(INITIAL_SETTINGS_STATE_V2), INITIAL_SETTINGS_STATE_V2_TEXT);
  assert.equal(sha256(INITIAL_SETTINGS_DOCUMENT_V2_TEXT), INITIAL_SETTINGS_DOCUMENT_V2_SHA256);
  assert.equal(sha256(INITIAL_SETTINGS_STATE_V2_TEXT), INITIAL_SETTINGS_STATE_V2_SHA256);
  assert.equal(hashSettingsDocumentV2(INITIAL_SETTINGS_DOCUMENT_V2), INITIAL_SETTINGS_DOCUMENT_V2_HASH);
  assert.equal(hashSettingsStateV2(INITIAL_SETTINGS_STATE_V2), INITIAL_SETTINGS_STATE_V2_HASH);
  assert.notEqual(INITIAL_SETTINGS_DOCUMENT_V2_HASH, INITIAL_SETTINGS_DOCUMENT_V2_SHA256);
  assert.notEqual(INITIAL_SETTINGS_STATE_V2_HASH, INITIAL_SETTINGS_STATE_V2_SHA256);
  assert.equal(SETTINGS_DOCUMENT_V2_HASH_DOMAIN, "settings-document-v2\0");
  assert.equal(SETTINGS_STATE_V2_HASH_DOMAIN, "settings-state-v2\0");
});

test("sampling parses as a closed optional profile object and projects to runtime", () => {
  // The real api.openai.com host, and gpt-4o rather than the usual
  // model-fixture placeholder: phraseBias and bannedStrings only validate
  // as available for the "openai" preset (a fixed, trustworthy host) with
  // a model on the closed tokenizer allow-list
  // (shared/sampling-capabilities.ts) — "custom" (an arbitrary base URL,
  // like the usual models.example fixture host) is subtracted, because a
  // self-hosted server reached through it could report any model name.
  const base = convertGenerationSettingsV1(legacy(
    "openai-compatible",
    "https://api.openai.com/v1",
    "gpt-4o",
    null
  ));
  // "wolf" and "spam" are each single-token in every one of the four
  // surface variants (typed, leading space, capitalized, leading space
  // capitalized) under o200k_base — a phrase that needs more than one
  // token in any variant is rejected at resolution, and this test exercises
  // the accepted path.
  const sampling = {
    ...EMPTY_SAMPLING_V2,
    topP: 0.9,
    frequencyPenalty: 0.2,
    presencePenalty: -0.1,
    seed: 7,
    stop: ["END", "DONE"],
    logitBias: { "15043": 1 },
    bannedStrings: ["spam"],
    phraseBias: [{ phrase: "wolf", weight: 4 }]
  } as const;
  const document = parseSettingsDocumentV2({
    ...base,
    profiles: {
      ...base.profiles,
      default: { ...base.profiles.default!, sampling }
    }
  });
  assert.deepEqual(document.profiles.default?.sampling, sampling);
  assert.deepEqual(effectiveGenerationRuntime(
    document,
    "default",
    {},
    undefined,
    { subscription: SUBSCRIPTION_RUNTIME }
  ).providerRuntime.sampling, sampling);
  assert.deepEqual(
    parseSettingsDocumentV2Text(formatSettingsDocumentV2(document)),
    document
  );
});

// Regression test for issue #282 review round 3, finding 2: a phrase-bias
// entry with a real weight conflict on at least one of its tokens — not
// merely overlapping tokens that agree on a weight — must block the save
// itself, synchronously, at document parse time, the same way an
// unavailable preset or a too-large weight already does. "Hello"'s two
// distinct surface texts ("Hello", " Hello") are also two of "hello"'s four,
// and the two entries here name different weights for them, so "hello"
// loses its own bias on those two forms to "Hello" — a real conflict a
// save must never ship silently.
test("a phrase-bias entry with a real weight conflict on some of its tokens fails the save synchronously", () => {
  const base = convertGenerationSettingsV1(legacy(
    "openai-compatible",
    "https://api.openai.com/v1",
    "gpt-4o",
    null
  ));
  assert.throws(() => parseSettingsDocumentV2({
    ...base,
    profiles: {
      ...base.profiles,
      default: {
        ...base.profiles.default!,
        sampling: {
          topP: null,
          topK: null,
          minP: null,
          frequencyPenalty: null,
          presencePenalty: null,
          repeatPenalty: null,
          seed: null,
          dryMultiplier: null,
          dryBase: null,
          dryRange: null,
          xtcThreshold: null,
          xtcProbability: null,
          dynatempRange: null,
          mirostat: null,
          mirostatTau: null,
          mirostatEta: null,
          stop: [],
          logitBias: {},
          bannedStrings: [],
          phraseBias: [
            { phrase: "hello", weight: 20 },
            { phrase: "Hello", weight: -20 }
          ],
          dryBreakers: []
        }
      }
    }
  }), /profile default cannot use "hello" as configured: "hello" loses its bias on "Hello", " Hello" to phrase bias "Hello"/);
});

test("a document saved before phraseBias and bannedStrings existed still decodes", () => {
  const base = convertGenerationSettingsV1(legacy(
    "openai-compatible",
    "https://models.example/v1",
    "model-fixture",
    null
  ));
  const legacySampling = {
    topP: 0.9,
    topK: null,
    minP: null,
    frequencyPenalty: null,
    presencePenalty: null,
    repeatPenalty: null,
    // seed, and every scalar and dryBreakers below down to logitBias, are
    // required (unlike phraseBias/bannedStrings below): each was added
    // after this document's era, but not as an additive-optional field, so
    // a document from before phraseBias/bannedStrings existed still needs
    // them explicitly — this test's own claim is scoped to
    // phraseBias/bannedStrings, not every field ever added later.
    seed: null,
    dryMultiplier: null,
    dryBase: null,
    dryRange: null,
    xtcThreshold: null,
    xtcProbability: null,
    dynatempRange: null,
    mirostat: null,
    mirostatTau: null,
    mirostatEta: null,
    stop: ["END"],
    logitBias: { "15043": 1 },
    dryBreakers: []
  };
  const document = parseSettingsDocumentV2({
    ...base,
    profiles: {
      ...base.profiles,
      default: { ...base.profiles.default!, sampling: legacySampling }
    }
  });
  assert.deepEqual(document.profiles.default?.sampling, {
    ...legacySampling,
    bannedStrings: [],
    phraseBias: []
  });
});

test("all-empty sampling normalizes away and preserves the initial settings identity", () => {
  const document = parseSettingsDocumentV2({
    ...INITIAL_SETTINGS_DOCUMENT_V2,
    profiles: {
      ...INITIAL_SETTINGS_DOCUMENT_V2.profiles,
      default: {
        ...INITIAL_SETTINGS_DOCUMENT_V2.profiles.default!,
        sampling: EMPTY_SAMPLING_V2
      }
    }
  });
  assert.equal(Object.hasOwn(document.profiles.default!, "sampling"), false);
  assert.equal(formatSettingsDocumentV2(document), INITIAL_SETTINGS_DOCUMENT_V2_TEXT);
  assert.equal(hashSettingsDocumentV2(document), INITIAL_SETTINGS_DOCUMENT_V2_HASH);
});

// tokenProbabilities (issue #291 phase 1) is an optional profile scalar,
// wired the same way `sampling` is above: absent by default, so a document
// saved before the field existed keeps meaning exactly what it did.
// An empty author brief is a real choice: it leaves the model unsteered, and
// `renderContinuationPlan` already omits the system block for one. A minimum
// length of a single scalar was the only thing refusing it.
test("an empty default author brief saves and round-trips", () => {
  const base = convertGenerationSettingsV1(legacy(
    "openai-compatible",
    "https://models.example/v1",
    "model-fixture",
    null
  ));
  const document = parseSettingsDocumentV2({ ...base, writing: { defaultAuthorBrief: "" } });
  assert.equal(document.writing.defaultAuthorBrief, "");
  assert.deepEqual(parseSettingsDocumentV2Text(formatSettingsDocumentV2(document)), document);
});

test("tokenProbabilities parses as a closed optional profile scalar and round-trips", () => {
  const base = convertGenerationSettingsV1(legacy(
    "openai-compatible",
    "https://models.example/v1",
    "model-fixture",
    null
  ));
  const document = parseSettingsDocumentV2({
    ...base,
    profiles: {
      ...base.profiles,
      default: { ...base.profiles.default!, tokenProbabilities: 8 }
    }
  });
  assert.equal(document.profiles.default?.tokenProbabilities, 8);
  assert.deepEqual(parseSettingsDocumentV2Text(formatSettingsDocumentV2(document)), document);
});

// A codec that ever spread `tokenProbabilities: undefined` into the parsed
// profile would make `canonicalJson` throw the moment this document's hash
// is computed below (it rejects an own key with an undefined value) — this
// is the regression test for that failure mode, not just an absence check.
test("tokenProbabilities stays absent through a document round trip when unset", () => {
  const document = parseSettingsDocumentV2(INITIAL_SETTINGS_DOCUMENT_V2);
  assert.equal(Object.hasOwn(document.profiles.default!, "tokenProbabilities"), false);
  assert.equal(formatSettingsDocumentV2(document), INITIAL_SETTINGS_DOCUMENT_V2_TEXT);
  assert.equal(hashSettingsDocumentV2(document), INITIAL_SETTINGS_DOCUMENT_V2_HASH);
});

test("tokenProbabilities bounds reject 0 and past the alternative ceiling", () => {
  const base = convertGenerationSettingsV1(legacy(
    "openai-compatible",
    "https://models.example/v1",
    "model-fixture",
    null
  ));
  const withTokenProbabilities = (tokenProbabilities: number) => parseSettingsDocumentV2({
    ...base,
    profiles: {
      ...base.profiles,
      default: { ...base.profiles.default!, tokenProbabilities }
    }
  });
  assert.throws(() => withTokenProbabilities(0), /tokenProbabilities/);
  assert.throws(() => withTokenProbabilities(1.5), /tokenProbabilities/);
  assert.throws(() => withTokenProbabilities(MAX_ALTERNATIVE_TOKENS + 1), /tokenProbabilities/);
  assert.doesNotThrow(() => withTokenProbabilities(1));
  assert.doesNotThrow(() => withTokenProbabilities(MAX_ALTERNATIVE_TOKENS));
});

// reasoning and discardReasoning are optional profile fields, wired the same
// way tokenProbabilities is above: absent by default, so a document saved
// before either field existed keeps meaning exactly what it did.
test("reasoning and discardReasoning parse as closed optional profile fields and project to runtime", () => {
  const base = convertGenerationSettingsV1(legacy(
    "openai-compatible",
    "https://models.example/v1",
    "model-fixture",
    null
  ));
  const modelId = base.profiles.default!.modelId;
  const document = parseSettingsDocumentV2({
    ...base,
    models: {
      ...base.models,
      [modelId]: {
        ...base.models[modelId]!,
        capabilities: { ...base.models[modelId]!.capabilities, reasoningContent: "supported" }
      }
    },
    profiles: {
      ...base.profiles,
      default: { ...base.profiles.default!, reasoning: "open", discardReasoning: true }
    }
  });
  assert.equal(document.profiles.default?.reasoning, "open");
  assert.equal(document.profiles.default?.discardReasoning, true);
  assert.deepEqual(parseSettingsDocumentV2Text(formatSettingsDocumentV2(document)), document);
  const runtime = effectiveGenerationRuntime(
    document,
    "default",
    {},
    undefined,
    { subscription: SUBSCRIPTION_RUNTIME }
  ).providerRuntime;
  assert.equal(runtime.reasoning, "open");
  assert.equal(runtime.keepReasoning, false);
});

// The same regression this file already covers for tokenProbabilities: a
// codec that ever spread `reasoning: undefined` or `discardReasoning:
// undefined` into the parsed profile would make `canonicalJson` throw the
// moment this document's hash is computed below.
test("reasoning and discardReasoning stay absent through a document round trip when unset", () => {
  const document = parseSettingsDocumentV2(INITIAL_SETTINGS_DOCUMENT_V2);
  assert.equal(Object.hasOwn(document.profiles.default!, "reasoning"), false);
  assert.equal(Object.hasOwn(document.profiles.default!, "discardReasoning"), false);
  assert.equal(formatSettingsDocumentV2(document), INITIAL_SETTINGS_DOCUMENT_V2_TEXT);
  assert.equal(hashSettingsDocumentV2(document), INITIAL_SETTINGS_DOCUMENT_V2_HASH);
  const runtime = effectiveGenerationRuntime(
    document,
    "default",
    {},
    undefined,
    { subscription: SUBSCRIPTION_RUNTIME }
  ).providerRuntime;
  assert.equal(runtime.reasoning, "marker");
  assert.equal(runtime.keepReasoning, true);
});

test("reasoning stays selectable on an unproven model and is refused only where the model returns none", () => {
  const base = convertGenerationSettingsV1(legacy(
    "openai-compatible",
    "https://models.example/v1",
    "model-fixture",
    null
  ));
  const modelId = base.profiles.default!.modelId;
  const model = base.models[modelId]!;
  const parseWith = (reasoning: unknown, reasoningContent?: string) => parseSettingsDocumentV2({
    ...base,
    models: {
      ...base.models,
      [modelId]: {
        ...model,
        capabilities: {
          ...model.capabilities,
          ...(reasoningContent === undefined ? {} : { reasoningContent })
        }
      }
    },
    profiles: {
      ...base.profiles,
      default: { ...base.profiles.default!, reasoning }
    }
  });
  // The migrated model declares no `reasoningContent`, so it resolves to
  // "unknown". Whether an arbitrary endpoint emits reasoning cannot be known
  // before the request, and a thought that never arrives renders nothing, so
  // an undeclared capability must not narrow the choice.
  assert.doesNotThrow(() => parseWith("off"));
  assert.doesNotThrow(() => parseWith("marker"));
  assert.doesNotThrow(() => parseWith("open"));
  // A model that reports it returns none keeps `off` and refuses the rest.
  assert.doesNotThrow(() => parseWith("off", "unsupported"));
  assert.throws(() => parseWith("marker", "unsupported"), /reasoning/);
  assert.throws(() => parseWith("open", "unsupported"), /reasoning/);
  assert.throws(() => parseWith("thinking"), /reasoning/);
});

test("discardReasoning only ever parses as the literal true", () => {
  const base = convertGenerationSettingsV1(legacy(
    "openai-compatible",
    "https://models.example/v1",
    "model-fixture",
    null
  ));
  assert.throws(() => parseSettingsDocumentV2({
    ...base,
    profiles: {
      ...base.profiles,
      default: { ...base.profiles.default!, discardReasoning: false }
    }
  }), /discardReasoning/);
});

test("sampling bounds and closed-shape rules fail before request lowering", () => {
  const base = convertGenerationSettingsV1(legacy(
    "openai-compatible",
    "https://models.example/v1",
    "model-fixture",
    null
  ));
  const profile = base.profiles.default!;
  const sampling = {
    ...EMPTY_SAMPLING_V2,
    topP: 0.9
  };
  const withSampling = (next: Record<string, unknown>) => ({
    ...base,
    profiles: {
      ...base.profiles,
      default: { ...profile, sampling: { ...sampling, ...next } }
    }
  });
  assert.throws(() => parseSettingsDocumentV2(withSampling({ topP: 2 })), /topP/);
  assert.throws(() => parseSettingsDocumentV2(withSampling({ topK: 100_001 })), /topK/);
  assert.throws(() => parseSettingsDocumentV2(withSampling({ repeatPenalty: 0.9 })), /repeatPenalty/);
  assert.throws(() => parseSettingsDocumentV2(withSampling({ seed: 0 })), /seed/);
  assert.throws(() => parseSettingsDocumentV2(withSampling({ seed: 1_000_000 })), /seed/);
  assert.throws(() => parseSettingsDocumentV2(withSampling({ stop: ["", "END"] })), /stop/);
  assert.throws(() => parseSettingsDocumentV2(withSampling({ stop: ["END", "END"] })), /repeats/);
  assert.throws(() => parseSettingsDocumentV2(withSampling({ logitBias: { "01": 1 } })), /logitBias/);
  assert.throws(() => parseSettingsDocumentV2(withSampling({
    logitBias: Object.fromEntries(
      Array.from({ length: SAMPLING_LOGIT_BIAS_POLICY.maxEntries + 1 }, (_, index) => [String(index), 1])
    )
  })), /logitBias/);
  assert.throws(() => parseSettingsDocumentV2(withSampling({
    bannedStrings: Array.from({ length: SAMPLING_BANNED_STRINGS_POLICY.maxEntries + 1 }, (_, index) => `word-${index}`)
  })), /bannedStrings/);
  assert.throws(() => parseSettingsDocumentV2(withSampling({
    bannedStrings: ["repeat", "repeat"]
  })), /repeats/);
  assert.throws(() => parseSettingsDocumentV2(withSampling({
    phraseBias: [{ phrase: "raven", weight: 200 }]
  })), /phraseBias/);
  assert.throws(() => parseSettingsDocumentV2(withSampling({
    phraseBias: [{ phrase: "raven", weight: 1 }, { phrase: "raven", weight: 2 }]
  })), /repeats/);
  // Regression test for issue #282 review finding D: the generated schema
  // declares PhraseBiasEntry with additionalProperties: false, so the codec
  // must reject the same shape the schema does — accepting it here would
  // silently drop "typo" on the next round trip instead of rejecting it up
  // front.
  assert.throws(() => parseSettingsDocumentV2(withSampling({
    phraseBias: [{ phrase: "raven", weight: 1, typo: true }]
  })), /unknown key/);
  assert.throws(() => parseSettingsDocumentV2(withSampling({
    extra: true
  })), /unknown key/);
});

// The schema and the codec bound dryBreakers differently on purpose. The
// generated JSON Schema says `maxLength: 40`, which counts characters, because
// JSON Schema cannot express a byte length; the codec says 40 UTF-8 bytes, to
// match llama.cpp's own byte-level truncation. "€" is one character and three
// bytes, so 14 of them clear the schema and must still fail the codec. The
// pair of assertions is the point: one character count on either side of the
// byte line.
test("a dry breaker of 14 \"€\" characters is refused for exceeding 40 UTF-8 bytes, and 13 parses", () => {
  // dryBreakers is a llama.cpp and KoboldCpp extension, so this case switches
  // the connection preset the way the ollama case above does.
  const base = convertGenerationSettingsV1(legacy(
    "openai-compatible",
    "https://models.example/v1",
    "model-fixture",
    null
  ));
  const llamaCpp = {
    ...base,
    connections: {
      ...base.connections,
      "migrated:connection": {
        ...base.connections["migrated:connection"]!,
        preset: "llama-cpp" as const
      }
    }
  };
  const withBreaker = (breaker: string) => parseSettingsDocumentV2({
    ...llamaCpp,
    profiles: {
      ...llamaCpp.profiles,
      default: {
        ...llamaCpp.profiles.default!,
        sampling: { ...EMPTY_SAMPLING_V2, dryBreakers: [breaker] }
      }
    }
  });
  assert.throws(() => withBreaker("€".repeat(14)), /dryBreakers.*must be 1\.\.40 UTF-8 bytes/);
  assert.doesNotThrow(() => withBreaker("€".repeat(13)));
});

test("save-time sampling validation refuses unavailable preset and model cells", () => {
  const base = convertGenerationSettingsV1(legacy(
    "openai-compatible",
    "https://models.example/v1",
    "model-fixture",
    null
  ));
  const profile = base.profiles.default!;
  const ollama = {
    ...base,
    connections: {
      ...base.connections,
      "migrated:connection": {
        ...base.connections["migrated:connection"]!,
        preset: "ollama" as const
      }
    },
    profiles: {
      ...base.profiles,
      default: {
        ...profile,
        sampling: {
          ...EMPTY_SAMPLING_V2,
          logitBias: { "1": 1 }
        }
      }
    }
  };
  assert.throws(
    () => parseSettingsDocumentV2(ollama),
    /logit bias.*because this provider does not support it/
  );

  const anthropic = convertGenerationSettingsV1(legacy(
    "anthropic",
    "https://api.anthropic.com",
    "claude-new-model",
    null
  ));
  assert.throws(() => parseSettingsDocumentV2({
    ...anthropic,
    profiles: {
      ...anthropic.profiles,
      default: {
        ...anthropic.profiles.default!,
        sampling: {
          ...EMPTY_SAMPLING_V2,
          topP: 0.9
        }
      }
    }
  }), /top p.*model/);
});

test("parsed settings documents and states are deeply immutable", () => {
  const document = parseSettingsDocumentV2Text(INITIAL_SETTINGS_DOCUMENT_V2_TEXT);
  const state = parseSettingsStateV2Text(INITIAL_SETTINGS_STATE_V2_TEXT);
  assert.ok(Object.isFrozen(document));
  assert.ok(Object.isFrozen(document.connections["builtin:dry-run"]));
  assert.ok(Object.isFrozen(state));
  assert.ok(Object.isFrozen(state.documents["1"]));
});

test("strict codecs reject duplicate keys, noncanonical bytes, BOM, fatal UTF-8, and oversize input", () => {
  assert.throws(
    () => parseSettingsDocumentV2Text(INITIAL_SETTINGS_DOCUMENT_V2_TEXT.replace("{", '{"schemaVersion":2,')),
    /duplicate/
  );
  assert.throws(() => parseSettingsDocumentV2Text(`${INITIAL_SETTINGS_DOCUMENT_V2_TEXT}\n`), /canonical/);
  assert.throws(
    () => parseSettingsDocumentV2Bytes(Uint8Array.of(0xef, 0xbb, 0xbf, 0x7b, 0x7d)),
    /UTF-8/
  );
  assert.throws(() => parseSettingsDocumentV2Bytes(Uint8Array.of(0xff)), /UTF-8/);
  assert.throws(
    () => parseSettingsDocumentV2Bytes(Buffer.alloc(MAX_SETTINGS_DOCUMENT_BYTES + 1)),
    /size limit/
  );
  assert.throws(
    () => parseSettingsStateV2Bytes(Buffer.alloc(MAX_SETTINGS_STATE_BYTES + 1)),
    /size limit/
  );
});

test("v1 absent default is exact, while the strict v1 reader accepts historical formatting", () => {
  assert.equal(sha256(ABSENT_SETTINGS_V1_TEXT), ABSENT_SETTINGS_V1_HASH);
  assert.equal(formatGenerationSettingsV1(ABSENT_SETTINGS_V1), ABSENT_SETTINGS_V1_TEXT);
  assert.deepEqual(
    parseGenerationSettingsV1Text(`${JSON.stringify(ABSENT_SETTINGS_V1, null, 2)}\n`),
    ABSENT_SETTINGS_V1
  );
  assert.throws(
    () => parseGenerationSettingsV1Text(ABSENT_SETTINGS_V1_TEXT.replace("{", '{"apiKeyEnv":null,')),
    /duplicate/
  );
  assert.throws(
    () => parseGenerationSettingsV1Text(canonicalJson({ ...ABSENT_SETTINGS_V1, future: true })),
    /unknown key/
  );
});

test("v1 conversion preserves provider request fields for all shipped preset URLs", () => {
  const cases: Array<[GenerationSettings, string]> = [
    [legacy("dry-run", "", "", null), "dry-run"],
    [legacy("openai-compatible", "https://api.openai.com/v1/", "gpt-test", "OPENAI_API_KEY"), "openai"],
    [legacy("openai-compatible", "https://openrouter.ai/api/v1", "router/test", "OPENROUTER_API_KEY"), "openrouter"],
    [legacy("openai-compatible", "http://127.0.0.1:1234/v1", "local", null), "lm-studio"],
    [legacy("openai-compatible", "http://127.0.0.1:11434/v1", "local", null), "ollama"],
    [legacy("openai-compatible", "http://127.0.0.1:8080/v1", "local", null), "llama-cpp"],
    [legacy("openai-compatible", "http://127.0.0.1:5001/v1", "local", null), "koboldcpp"],
    [legacy("openai-compatible", "https://models.example/v1", "custom", null), "custom"],
    [legacy("anthropic", "https://api.anthropic.com/", "claude-test", "ANTHROPIC_API_KEY"), "anthropic"],
    [legacy("anthropic", "https://gateway.example/v1", "claude-test", "ANTHROPIC_API_KEY"), "custom"]
  ];
  for (const [settings, expectedPreset] of cases) {
    const document = convertGenerationSettingsV1(settings);
    const connection = document.connections["migrated:connection"]!;
    assert.equal(connection.preset, expectedPreset);
    const projected = effectiveGenerationView(document);
    assert.deepEqual(projected, {
      ...settings,
      baseUrl: settings.baseUrl.replace(/\/+$/u, ""),
      model: settings.provider === "dry-run" ? "dry-run" : settings.model
    });
  }
});

test("effective scalar resolution shares exact precedence and caps the profile output budget", () => {
  const fullyPopulated = parseSettingsDocumentV2({
    ...INITIAL_SETTINGS_DOCUMENT_V2,
    routing: { default: "default", utility: "default" },
    profiles: {
      default: {
        ...INITIAL_SETTINGS_DOCUMENT_V2.profiles.default!,
        maxOutputTokens: 10_000
      }
    },
    models: {
      "builtin:dry-run": {
        ...INITIAL_SETTINGS_DOCUMENT_V2.models["builtin:dry-run"]!,
        discovered: { contextWindow: 30_000, maxOutputTokens: 3_000 },
        overrides: { contextWindow: 60_000, maxOutputTokens: 6_000 }
      }
    }
  });
  const allMetadata = {
    runtime: { contextWindow: 50_000, maxOutputTokens: 5_000 },
    builtin: { contextWindow: 20_000, maxOutputTokens: 2_000 }
  };
  assert.deepEqual(
    scalarProjection(effectiveGenerationView(fullyPopulated, "prose", allMetadata)),
    { contextWindow: 60_000, maxTokens: 6_000 },
    "explicit overrides win and an absent prose route falls back to default"
  );

  const runtimeWins = parseSettingsDocumentV2({
    ...fullyPopulated,
    models: {
      "builtin:dry-run": {
        ...fullyPopulated.models["builtin:dry-run"]!,
        overrides: {}
      }
    }
  });
  assert.deepEqual(
    scalarProjection(effectiveGenerationView(runtimeWins, "utility", allMetadata)),
    { contextWindow: 50_000, maxTokens: 5_000 },
    "runtime metadata wins when no override exists"
  );
  assert.deepEqual(
    scalarProjection(effectiveGenerationView(runtimeWins, "default", {
      builtin: allMetadata.builtin
    })),
    { contextWindow: 30_000, maxTokens: 3_000 },
    "discovered metadata wins when override and runtime values are absent"
  );

  const builtinWins = parseSettingsDocumentV2({
    ...runtimeWins,
    models: {
      "builtin:dry-run": {
        ...runtimeWins.models["builtin:dry-run"]!,
        discovered: {}
      }
    }
  });
  assert.deepEqual(
    scalarProjection(effectiveGenerationView(builtinWins, "default", {
      builtin: allMetadata.builtin
    })),
    { contextWindow: 20_000, maxTokens: 2_000 },
    "built-in metadata wins only after override, runtime, and discovery"
  );
  assert.deepEqual(
    scalarProjection(effectiveGenerationView(builtinWins)),
    { contextWindow: null, maxTokens: 10_000 },
    "unknown model limits leave context unknown and preserve the profile budget"
  );

  const profileCapsOutput = parseSettingsDocumentV2({
    ...fullyPopulated,
    profiles: {
      default: {
        ...fullyPopulated.profiles.default!,
        maxOutputTokens: 1_500
      }
    }
  });
  assert.equal(
    effectiveGenerationView(profileCapsOutput, "default", allMetadata).maxTokens,
    1_500,
    "a model maximum above the requested profile budget does not raise the request"
  );
});

test("profile model references require own model-map properties", () => {
  const defaultProfile = INITIAL_SETTINGS_DOCUMENT_V2.profiles.default;
  if (defaultProfile === undefined) throw new Error("Initial default profile is missing");
  for (const modelId of ["constructor", "toString"]) {
    assert.throws(
      () => parseSettingsDocumentV2({
        ...INITIAL_SETTINGS_DOCUMENT_V2,
        profiles: {
          ...INITIAL_SETTINGS_DOCUMENT_V2.profiles,
          default: {
            ...defaultProfile,
            modelId
          }
        }
      }),
      /profile default\.modelId does not resolve/
    );
  }
});

test("selected network runtime lowering rejects blank model IDs without normalizing nonblank IDs", () => {
  const base = convertGenerationSettingsV1(legacy(
    "openai-compatible",
    "https://models.example/v1",
    "  exact/model-id  ",
    null
  ));
  const selected = base.models["migrated:model"]!;
  const document = parseSettingsDocumentV2({
    ...base,
    models: {
      ...base.models,
      "unselected:model": {
        ...selected,
        remoteId: " \t "
      }
    }
  });
  assert.equal(
    effectiveGenerationView(document).model,
    "  exact/model-id  ",
    "the provider receives the exact admitted nonblank identifier"
  );

  const blankSelected = parseSettingsDocumentV2({
    ...document,
    models: {
      ...document.models,
      "migrated:model": {
        ...selected,
        remoteId: " \t "
      }
    }
  });
  assert.throws(
    () => effectiveGenerationView(blankSelected),
    /nonblank model remote ID/
  );
});

test("Anthropic runtime lowering preserves exact authentication references", () => {
  const base = convertGenerationSettingsV1(legacy(
    "anthropic",
    "https://api.anthropic.com",
    "claude-test",
    "ANTHROPIC_API_KEY"
  ));
  const connection = base.connections["migrated:connection"]!;
  const model = base.models["migrated:model"]!;
  assert.equal(effectiveGenerationView(base).apiKeyEnv, "ANTHROPIC_API_KEY");
  const unselected = parseSettingsDocumentV2({
    ...INITIAL_SETTINGS_DOCUMENT_V2,
    connections: {
      ...INITIAL_SETTINGS_DOCUMENT_V2.connections,
      "unselected:anthropic": {
        ...connection,
        auth: { type: "none" }
      }
    },
    models: {
      ...INITIAL_SETTINGS_DOCUMENT_V2.models,
      "unselected:anthropic": {
        ...model,
        connectionId: "unselected:anthropic"
      }
    }
  });
  assert.equal(
    effectiveGenerationView(unselected).provider,
    "dry-run",
    "runtime-only Anthropic authentication constraints do not reject an unselected record"
  );
  for (const auth of [
    { type: "bearer-env" as const, env: "ANTHROPIC_API_KEY" },
    { type: "header-env" as const, name: "X-Provider-Key", env: "ANTHROPIC_API_KEY" }
  ]) {
    const document = parseSettingsDocumentV2({
      ...base,
      connections: {
        ...base.connections,
        "migrated:connection": {
          ...connection,
          auth
        }
      }
    });
    const effective = effectiveGenerationView(document);
    assert.equal(effective.apiKeyEnv, "ANTHROPIC_API_KEY");
    assert.deepEqual(effectiveGenerationRuntime(
      document,
      "default",
      {},
      undefined,
      { subscription: SUBSCRIPTION_RUNTIME }
    ).providerRuntime.auth, auth);
  }
  for (const auth of [
    { type: "bearer-stored" as const, secretId: "migrated:connection" },
    {
      type: "header-stored" as const,
      name: "X-Provider-Key",
      secretId: "migrated:connection:X-Provider-Key"
    }
  ]) {
    const document = parseSettingsDocumentV2({
      ...base,
      connections: {
        ...base.connections,
        "migrated:connection": { ...connection, auth }
      }
    });
    assert.deepEqual(
      parseSettingsDocumentV2Text(formatSettingsDocumentV2(document)),
      document
    );
    const effective = effectiveGenerationView(document);
    assert.equal(effective.apiKeyEnv, null);
    assert.deepEqual(effectiveGenerationRuntime(
      document,
      "default",
      {},
      undefined,
      { subscription: SUBSCRIPTION_RUNTIME }
    ).providerRuntime.auth, auth);
  }
  const customHeaderDocument = parseSettingsDocumentV2({
    ...base,
    connections: {
      ...base.connections,
      "migrated:connection": {
        ...connection,
        auth: { type: "none" },
        headers: [{
          name: "x-api-key",
          value: { type: "env", env: "ANTHROPIC_API_KEY" }
        }]
      }
    }
  });
  const effective = effectiveGenerationView(customHeaderDocument);
  assert.equal(effective.apiKeyEnv, null);
  assert.deepEqual(effectiveGenerationRuntime(
    customHeaderDocument,
    "default",
    {},
    undefined,
    { subscription: SUBSCRIPTION_RUNTIME }
  ).providerRuntime.headers, [{
    name: "x-api-key",
    value: { type: "env", env: "ANTHROPIC_API_KEY" }
  }]);
});

test("Anthropic runtime lowering rejects normalized effort off without a wire mapping", () => {
  const base = convertGenerationSettingsV1(legacy(
    "anthropic",
    "https://api.anthropic.com",
    "claude-fixture",
    "ANTHROPIC_API_KEY"
  ));
  const model = base.models["migrated:model"]!;
  const profile = base.profiles.default!;
  const document = {
    ...base,
    models: {
      ...base.models,
      "migrated:model": {
        ...model,
        capabilities: {
          ...model.capabilities,
          reasoningEffort: "supported" as const
        }
      }
    },
    profiles: {
      ...base.profiles,
      default: { ...profile, effort: "off" as const }
    }
  };

  assert.throws(
    () => effectiveGenerationView(document),
    /Anthropic does not support generation effort set to off\./
  );
});

test("routed profiles reject unsupported temperature and undeclared effort", () => {
  const base = convertGenerationSettingsV1(legacy(
    "openai-compatible",
    "https://models.example/v1",
    "model-fixture",
    null
  ));
  const model = base.models["migrated:model"]!;
  const profile = base.profiles.default!;

  assert.throws(
    () => effectiveGenerationView({
      ...base,
      models: {
        ...base.models,
        "migrated:model": {
          ...model,
          capabilities: {
            ...model.capabilities,
            temperature: "unsupported"
          }
        }
      }
    }),
    /sets temperature for an unsupported model/
  );
  assert.throws(
    () => effectiveGenerationView({
      ...base,
      profiles: {
        ...base.profiles,
        default: { ...profile, effort: "high" }
      }
    }),
    /sets effort without explicit model support/
  );
});

test("basic compatibility mapper preserves stable IDs and unrelated records", () => {
  const extra = convertGenerationSettingsV1(legacy(
    "openai-compatible",
    "https://models.example/v1",
    "old",
    null
  ));
  const document = parseSettingsDocumentV2({
    ...INITIAL_SETTINGS_DOCUMENT_V2,
    connections: {
      ...INITIAL_SETTINGS_DOCUMENT_V2.connections,
      "unused:connection": extra.connections["migrated:connection"]!
    }
  });
  const edited = applyEffectiveGenerationSettings(document, {
    ...effectiveGenerationView(document),
    provider: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    model: "new-model",
    apiKeyEnv: "OPENAI_API_KEY",
    contextWindow: 64_000
  });
  assert.ok(Object.hasOwn(edited.connections, "builtin:dry-run"));
  assert.deepEqual(edited.connections["unused:connection"], document.connections["unused:connection"]);
  assert.equal(edited.models["builtin:dry-run"]!.connectionId, "builtin:dry-run");
  assert.equal(edited.models["builtin:dry-run"]!.remoteId, "new-model");
  assert.equal(edited.models["builtin:dry-run"]!.overrides.contextWindow, 64_000);
});

test("document validation rejects future fields, reserved secrets, and unsafe endpoint forms", () => {
  assert.throws(() => parseSettingsDocumentV2({
    ...INITIAL_SETTINGS_DOCUMENT_V2,
    schemaVersion: 3
  }), SettingsFormatError);
  const base = convertGenerationSettingsV1(legacy(
    "openai-compatible",
    "https://models.example/v1",
    "model",
    "MODEL_KEY"
  ));
  for (const env of ["PATH", "NODE_OPTIONS", "XDG_CONFIG_HOME"]) {
    const connection = base.connections["migrated:connection"]!;
    assert.throws(() => parseSettingsDocumentV2({
      ...base,
      connections: {
        ...base.connections,
        "migrated:connection": { ...connection, auth: { type: "bearer-env", env } }
      }
    }), env);
  }
  const connection = base.connections["migrated:connection"]!;
  for (const baseUrl of [
    "ftp://example.com/v1",
    "https://user@example.com/v1",
    "https://example.com/v1?token=no",
    "https://example.com/v1?",
    "https://example.com/v1#fragment",
    "https://example.com/v1#",
    "http://example.com/v1"
  ]) {
    assert.throws(() => parseSettingsDocumentV2({
      ...base,
      connections: {
        ...base.connections,
        "migrated:connection": { ...connection, baseUrl, auth: { type: "none" } }
      }
    }), baseUrl);
  }
  assert.throws(() => parseSettingsDocumentV2({
    ...base,
    connections: {
      ...base.connections,
      "migrated:connection": {
        ...connection,
        baseUrl: "http://192.168.1.50:8080/v1",
        auth: {
          type: "bearer-stored",
          secretId: "migrated:connection"
        },
        allowInsecureHttp: true
      }
    }
  }), /plain HTTP cannot carry authentication/);
});

test("document validation rejects authentication/custom header collisions and protected headers", () => {
  const base = convertGenerationSettingsV1(legacy(
    "openai-compatible",
    "https://models.example/v1",
    "model",
    "MODEL_KEY"
  ));
  const connection = base.connections["migrated:connection"]!;
  assert.throws(() => parseSettingsDocumentV2({
    ...base,
    connections: {
      ...base.connections,
      "migrated:connection": {
        ...connection,
        auth: { type: "header-env", name: "X-Api-Key", env: "MODEL_KEY" },
        headers: [{ name: "x-api-key", value: { type: "env", env: "EXTRA_KEY" } }]
      }
    }
  }), /collides with authentication header/);
  assert.throws(() => parseSettingsDocumentV2({
    ...base,
    connections: {
      ...base.connections,
      "migrated:connection": {
        ...connection,
        headers: [{ name: "Authorization", value: { type: "env", env: "EXTRA_KEY" } }]
      }
    }
  }), /owned by the transport or authentication slot/);
  assert.throws(() => parseSettingsDocumentV2({
    ...base,
    connections: {
      ...base.connections,
      "migrated:connection": {
        ...connection,
        headers: [{ name: "Content-Type", value: { type: "env", env: "EXTRA_KEY" } }]
      }
    }
  }), /owned by the transport or authentication slot/);
});

test("schema 3 reads and validates; schema 2 refuses to mutate a schema-3 document", () => {
  const documentV3 = JSON.parse(INITIAL_SETTINGS_DOCUMENT_V3_TEXT) as Record<string, unknown>;
  const parsedV3 = parseSettingsDocumentV3Text(INITIAL_SETTINGS_DOCUMENT_V3_TEXT);
  assert.equal(parsedV3.schemaVersion, 3);
  assert.equal(
    parsedV3.models["builtin:dry-run"]!.capabilities.imageInput,
    "unsupported"
  );
  // The schema-2 codec, the only codec this release ever writes through,
  // refuses a schema-3 document outright, rather than silently downgrading
  // or mutating it.
  assert.throws(
    () => parseSettingsDocumentV2(documentV3),
    /schemaVersion must be 2/
  );
});

test("v2 to v3 migration: dry-run models become unsupported, every other model becomes unknown", () => {
  const networkModel = convertGenerationSettingsV1(legacy(
    "openai-compatible",
    "https://api.openai.com/v1",
    "gpt-4o",
    "OPENAI_API_KEY"
  ));
  const migrated = convertSettingsDocumentV2ToV3(networkModel);
  const migratedModel = migrated.models[migrated.profiles[migrated.routing.default]!.modelId]!;
  assert.equal(migratedModel.capabilities.imageInput, "unknown");

  const dryRun = convertGenerationSettingsV1(legacy("dry-run", "", "", null));
  const migratedDryRun = convertSettingsDocumentV2ToV3(dryRun);
  const dryRunModel = migratedDryRun.models[migratedDryRun.profiles[migratedDryRun.routing.default]!.modelId]!;
  assert.equal(dryRunModel.capabilities.imageInput, "unsupported");
});

test("imageTokenCeiling round-trips when present and stays absent when omitted", () => {
  const migrated = convertSettingsDocumentV2ToV3(convertGenerationSettingsV1(legacy(
    "openai-compatible",
    "https://api.openai.com/v1",
    "gpt-4o",
    "OPENAI_API_KEY"
  )));
  const modelId = migrated.profiles[migrated.routing.default]!.modelId;
  const model = migrated.models[modelId]!;
  assert.equal(model.capabilities.imageTokenCeiling, undefined);

  const withCeiling = validateSettingsDocumentV3({
    ...migrated,
    models: {
      ...migrated.models,
      [modelId]: {
        ...model,
        capabilities: { ...model.capabilities, imageInput: "supported", imageTokenCeiling: 4_096 }
      }
    }
  });
  assert.equal(withCeiling.models[modelId]!.capabilities.imageTokenCeiling, 4_096);
  const roundTripped = parseSettingsDocumentV3Text(formatSettingsDocumentV3(withCeiling));
  assert.equal(roundTripped.models[modelId]!.capabilities.imageTokenCeiling, 4_096);
});

test("imageTokenCeiling is schema-valid but codec-invalid without imageInput === supported", () => {
  const migrated = convertSettingsDocumentV2ToV3(convertGenerationSettingsV1(legacy(
    "openai-compatible",
    "https://api.openai.com/v1",
    "gpt-4o",
    "OPENAI_API_KEY"
  )));
  const modelId = migrated.profiles[migrated.routing.default]!.modelId;
  const model = migrated.models[modelId]!;
  assert.throws(
    () => validateSettingsDocumentV3({
      ...migrated,
      models: {
        ...migrated.models,
        [modelId]: {
          ...model,
          capabilities: { ...model.capabilities, imageInput: "unknown", imageTokenCeiling: 4_096 }
        }
      }
    }),
    /imageTokenCeiling requires imageInput to be "supported"/
  );
});

test("image input capability resolution: strict gate, override precedence, and safe strategies only", () => {
  // Only "supported" authorizes an image, and the protocol gates first.
  assert.equal(
    resolveImageInputCapability({ protocol: "dry-run", remoteModelId: "claude-sonnet-5" }).support,
    "unsupported"
  );
  assert.equal(
    resolveImageInputCapability({ protocol: "text-completions", remoteModelId: "claude-sonnet-5" }).support,
    "unsupported"
  );
  // Exact built-in model knowledge, with no override.
  assert.equal(
    resolveImageInputCapability({ protocol: "anthropic-messages", remoteModelId: "claude-sonnet-5" }).support,
    "supported"
  );
  assert.equal(
    resolveImageInputCapability({ protocol: "openai-chat-completions", remoteModelId: "gpt-4o" }).support,
    "supported"
  );
  // An unlisted model has no built-in strategy and no override: unknown.
  assert.equal(
    resolveImageInputCapability({ protocol: "openai-chat-completions", remoteModelId: "totally-unlisted-model" })
      .support,
    "unknown"
  );
  // A stored "unknown" override counts as no override.
  assert.equal(
    resolveImageInputCapability({
      protocol: "anthropic-messages",
      remoteModelId: "claude-sonnet-5",
      override: "unknown"
    }).support,
    "supported"
  );
  // An explicit "unsupported" override wins over built-in knowledge.
  assert.equal(
    resolveImageInputCapability({
      protocol: "anthropic-messages",
      remoteModelId: "claude-sonnet-5",
      override: "unsupported"
    }).support,
    "unsupported"
  );
  // "supported" on a model with no safe strategy (no built-in knowledge and
  // no explicit ceiling) resolves to "unknown", never a guessed fallback.
  const noStrategy = resolveImageInputCapability({
    protocol: "openai-chat-completions",
    remoteModelId: "some-custom-endpoint-model",
    override: "supported"
  });
  assert.equal(noStrategy.support, "unknown");
  // The same override with an explicit ceiling has a safe strategy.
  const withCeiling = resolveImageInputCapability({
    protocol: "openai-chat-completions",
    remoteModelId: "some-custom-endpoint-model",
    override: "supported",
    overrideTokenCeiling: 2_000
  });
  assert.equal(withCeiling.support, "supported");
});

function legacy(
  provider: GenerationSettings["provider"],
  baseUrl: string,
  model: string,
  apiKeyEnv: string | null
): GenerationSettings {
  return {
    provider,
    baseUrl,
    model,
    apiKeyEnv,
    temperature: 0.6,
    maxTokens: 512,
    systemPrompt: "Write exactly in this voice.",
    contextWindow: 16_384
  };
}

function scalarProjection(
  settings: GenerationSettings
): Pick<GenerationSettings, "contextWindow" | "maxTokens"> {
  const { contextWindow, maxTokens } = settings;
  return { contextWindow, maxTokens };
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
