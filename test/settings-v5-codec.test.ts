import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../server/canonical-json.js";
import {
  formatSettingsDocumentV5,
  formatSettingsStateV5,
  hashSettingsDocumentV5,
  hashSettingsStateV5,
  parseSettingsDocumentV5,
  parseSettingsDocumentV5Text,
  parseSettingsStateV5Text
} from "../server/settings-v5-codec.js";
import {
  INITIAL_SETTINGS_DOCUMENT_V5,
  INITIAL_SETTINGS_STATE_V5,
  INITIAL_SETTINGS_DOCUMENT_V5_HASH,
  INITIAL_SETTINGS_STATE_V5_HASH
} from "../server/settings-v5-default.js";
import {
  parseSettingsStateSlotBytes,
  requireSettingsStateSlotWriteAdmission
} from "../server/settings-state-slot.js";
import {
  SETTINGS_V5_CORPUS_SHA256,
  SETTINGS_V5_HASH_VECTORS_SHA256,
  SETTINGS_V5_SCHEMA_SHA256
} from "../shared/settings-v5-schema-identity.js";
import { assertSettingsV5SchemaCorpus } from "../scripts/settings-v5-schema-validation.js";
import {
  MAX_DEFAULT_CONTINUE_DIRECTION_SCALARS,
  MAX_WRITING_PROMPT_SCALARS
} from "../shared/settings-v5-limits.js";
import { SettingsFormatError } from "../server/settings-v2-scalars.js";

interface CorpusCase {
  name: string;
  kind: "document" | "state";
  schemaValid: boolean;
  text: string;
}

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const schemaText = readFileSync(path.join(ROOT, "schema", "settings-v5.schema.json"), "utf8");
const corpusText = readFileSync(path.join(ROOT, "schema", "settings-v5.corpus.json"), "utf8");
const vectorsText = readFileSync(path.join(ROOT, "schema", "settings-v5.hash-vectors.json"), "utf8");
const corpus = JSON.parse(corpusText) as { schemaVersion: number; cases: CorpusCase[] };

test("settings schema 5, corpus, and hash vectors are canonical and identity-pinned", () => {
  const schema = JSON.parse(schemaText) as Record<string, unknown>;
  assert.equal(canonicalJson(schema), schemaText);
  assert.equal(canonicalJson(JSON.parse(corpusText) as unknown), corpusText);
  assert.equal(canonicalJson(JSON.parse(vectorsText) as unknown), vectorsText);
  assert.equal(sha256(schemaText), SETTINGS_V5_SCHEMA_SHA256);
  assert.equal(sha256(corpusText), SETTINGS_V5_CORPUS_SHA256);
  assert.equal(sha256(vectorsText), SETTINGS_V5_HASH_VECTORS_SHA256);
  assert.doesNotThrow(() => assertSettingsV5SchemaCorpus(schema, corpus.cases));
});

test("schema 5 canonical vectors parse and round-trip", () => {
  assert.equal(hashSettingsDocumentV5(INITIAL_SETTINGS_DOCUMENT_V5), INITIAL_SETTINGS_DOCUMENT_V5_HASH);
  assert.equal(hashSettingsStateV5(INITIAL_SETTINGS_STATE_V5), INITIAL_SETTINGS_STATE_V5_HASH);
  assert.deepEqual(
    parseSettingsDocumentV5Text(formatSettingsDocumentV5(INITIAL_SETTINGS_DOCUMENT_V5)),
    INITIAL_SETTINGS_DOCUMENT_V5
  );
  assert.deepEqual(
    parseSettingsStateV5Text(formatSettingsStateV5(INITIAL_SETTINGS_STATE_V5)),
    INITIAL_SETTINGS_STATE_V5
  );
});

test("schema 5 keeps legacy and independent reasoning as distinct values", () => {
  const legacy = JSON.parse(formatSettingsDocumentV5(INITIAL_SETTINGS_DOCUMENT_V5)) as {
    profiles: Record<string, Record<string, unknown>>;
  };
  legacy.profiles.default!.generationReasoning = { kind: "legacy", effort: "off" };
  const parsedLegacy = parseSettingsDocumentV5(legacy);
  assert.deepEqual(parsedLegacy.profiles.default?.generationReasoning, {
    kind: "legacy",
    effort: "off"
  });

  const inferred = JSON.parse(formatSettingsDocumentV5(INITIAL_SETTINGS_DOCUMENT_V5)) as {
    profiles: Record<string, Record<string, unknown>>;
  };
  inferred.profiles.default!.generationReasoning = {
    effort: "default",
    thinkingMode: "default"
  };
  assert.throws(() => parseSettingsDocumentV5(inferred), /kind/u);
});

test("schema 5 writing fields reject unpaired surrogates and scalar overflow", () => {
  const surrogate = JSON.parse(formatSettingsDocumentV5(INITIAL_SETTINGS_DOCUMENT_V5)) as {
    writing: Record<string, string>;
  };
  surrogate.writing.rewriteGuidance = "bad\uD800";
  assert.throws(() => parseSettingsDocumentV5(surrogate), /unpaired Unicode surrogate/u);

  const overflow = JSON.parse(formatSettingsDocumentV5(INITIAL_SETTINGS_DOCUMENT_V5)) as {
    writing: Record<string, string>;
  };
  overflow.writing.titleGuidance = "a".repeat(MAX_WRITING_PROMPT_SCALARS + 1);
  assert.throws(() => parseSettingsDocumentV5(overflow), SettingsFormatError);

  const continueOverflow = JSON.parse(formatSettingsDocumentV5(INITIAL_SETTINGS_DOCUMENT_V5)) as {
    writing: Record<string, string>;
  };
  continueOverflow.writing.defaultContinueDirection = "a".repeat(
    MAX_DEFAULT_CONTINUE_DIRECTION_SCALARS + 1
  );
  assert.throws(() => parseSettingsDocumentV5(continueOverflow), SettingsFormatError);
});

test("schema 5 slot parsing reports schema 5 validation errors", () => {
  const raw = JSON.parse(formatSettingsStateV5(INITIAL_SETTINGS_STATE_V5)) as {
    documents: Record<string, {
      profiles: Record<string, Record<string, unknown>>;
    }>;
  };
  delete raw.documents["1"]!.profiles.default!.generationReasoning;
  assert.throws(
    () => parseSettingsStateSlotBytes(Buffer.from(canonicalJson(raw), "utf8")),
    (error: unknown) => error instanceof Error
      && /generationReasoning/u.test(error.message)
      && !/schemaVersion must be 2/u.test(error.message)
  );
});

test("schema 5 is mutable in this release", () => {
  const bytes = Buffer.from(formatSettingsStateV5(INITIAL_SETTINGS_STATE_V5), "utf8");
  const slot = parseSettingsStateSlotBytes(bytes);
  assert.equal(slot.kind, "v5");
  requireSettingsStateSlotWriteAdmission(slot);
});

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
