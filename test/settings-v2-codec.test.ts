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
  effectiveGenerationSettings
} from "../server/settings-v2-conversion.js";
import { providerRuntimeFor } from "../server/provider-runtime.js";
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
import type { GenerationSettings } from "../shared/types.js";
import {
  SETTINGS_V2_CORPUS_SHA256,
  SETTINGS_V2_HASH_VECTORS_SHA256,
  SETTINGS_V2_SCHEMA_SHA256
} from "../shared/settings-v2-schema-identity.js";
import { assertSettingsV2SchemaCorpus } from "../scripts/settings-v2-schema-validation.js";

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
    const parse = fixture.kind === "document" ? parseSettingsDocumentV2Text : parseSettingsStateV2Text;
    if (fixture.valid) assert.doesNotThrow(() => parse(fixture.text));
    else assert.throws(() => parse(fixture.text));
  });
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
  const base = convertGenerationSettingsV1(legacy(
    "openai-compatible",
    "https://models.example/v1",
    "model-fixture",
    null
  ));
  const sampling = {
    topP: 0.9,
    topK: null,
    minP: null,
    frequencyPenalty: 0.2,
    presencePenalty: -0.1,
    repeatPenalty: null,
    stop: ["END", "DONE"],
    logitBias: { "15043": 1 }
  } as const;
  const document = parseSettingsDocumentV2({
    ...base,
    profiles: {
      ...base.profiles,
      default: { ...base.profiles.default!, sampling }
    }
  });
  assert.deepEqual(document.profiles.default?.sampling, sampling);
  assert.deepEqual(providerRuntimeFor(effectiveGenerationSettings(document)).sampling, sampling);
  assert.deepEqual(
    parseSettingsDocumentV2Text(formatSettingsDocumentV2(document)),
    document
  );
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

test("sampling bounds and closed-shape rules fail before request lowering", () => {
  const base = convertGenerationSettingsV1(legacy(
    "openai-compatible",
    "https://models.example/v1",
    "model-fixture",
    null
  ));
  const profile = base.profiles.default!;
  const sampling = {
    topP: 0.9,
    topK: null,
    minP: null,
    frequencyPenalty: null,
    presencePenalty: null,
    repeatPenalty: null,
    stop: [],
    logitBias: {}
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
  assert.throws(() => parseSettingsDocumentV2(withSampling({ stop: ["", "END"] })), /stop/);
  assert.throws(() => parseSettingsDocumentV2(withSampling({ stop: ["END", "END"] })), /repeats/);
  assert.throws(() => parseSettingsDocumentV2(withSampling({ logitBias: { "01": 1 } })), /logitBias/);
  assert.throws(() => parseSettingsDocumentV2(withSampling({
    logitBias: Object.fromEntries(Array.from({ length: 17 }, (_, index) => [String(index), 1]))
  })), /logitBias/);
  assert.throws(() => parseSettingsDocumentV2(withSampling({
    extra: true
  })), /unknown key/);
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
          topP: null,
          topK: null,
          minP: null,
          frequencyPenalty: null,
          presencePenalty: null,
          repeatPenalty: null,
          stop: [],
          logitBias: { "1": 1 }
        }
      }
    }
  };
  assert.throws(() => parseSettingsDocumentV2(ollama), /logit bias.*preset/);

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
          topP: 0.9,
          topK: null,
          minP: null,
          frequencyPenalty: null,
          presencePenalty: null,
          repeatPenalty: null,
          stop: [],
          logitBias: {}
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
    const projected = effectiveGenerationSettings(document);
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
    scalarProjection(effectiveGenerationSettings(fullyPopulated, "prose", allMetadata)),
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
    scalarProjection(effectiveGenerationSettings(runtimeWins, "utility", allMetadata)),
    { contextWindow: 50_000, maxTokens: 5_000 },
    "runtime metadata wins when no override exists"
  );
  assert.deepEqual(
    scalarProjection(effectiveGenerationSettings(runtimeWins, "default", {
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
    scalarProjection(effectiveGenerationSettings(builtinWins, "default", {
      builtin: allMetadata.builtin
    })),
    { contextWindow: 20_000, maxTokens: 2_000 },
    "built-in metadata wins only after override, runtime, and discovery"
  );
  assert.deepEqual(
    scalarProjection(effectiveGenerationSettings(builtinWins)),
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
    effectiveGenerationSettings(profileCapsOutput, "default", allMetadata).maxTokens,
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
    effectiveGenerationSettings(document).model,
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
    () => effectiveGenerationSettings(blankSelected),
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
  assert.equal(effectiveGenerationSettings(base).apiKeyEnv, "ANTHROPIC_API_KEY");
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
    effectiveGenerationSettings(unselected).provider,
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
    const effective = effectiveGenerationSettings(document);
    assert.equal(effective.apiKeyEnv, "ANTHROPIC_API_KEY");
    assert.deepEqual(providerRuntimeFor(effective).auth, auth);
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
    const effective = effectiveGenerationSettings(document);
    assert.equal(effective.apiKeyEnv, null);
    assert.deepEqual(providerRuntimeFor(effective).auth, auth);
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
  const effective = effectiveGenerationSettings(customHeaderDocument);
  assert.equal(effective.apiKeyEnv, null);
  assert.deepEqual(providerRuntimeFor(effective).headers, [{
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
    () => effectiveGenerationSettings(document),
    /does not define a generation-effort mapping for off/
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
    () => effectiveGenerationSettings({
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
    () => effectiveGenerationSettings({
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
    ...effectiveGenerationSettings(document),
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
