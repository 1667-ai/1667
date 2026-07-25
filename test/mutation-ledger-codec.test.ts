import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../server/canonical-json.js";
import {
  formatMutationLedgerRecord,
  hashPreparedMutationRecord,
  hashStartedMutationRecord,
  parseMutationLedgerRecordBytes,
  parseMutationLedgerRecordText
} from "../server/mutation-ledger-codec.js";
import {
  MAX_MUTATION_LEDGER_RECORD_BYTES,
  MUTATION_ID_PATTERN,
  MUTATION_ID_PATTERN_SOURCE,
  MutationLedgerFormatError
} from "../server/mutation-ledger-scalars.js";
import type {
  DurableMutationMethod,
  MutationLedgerRecord,
  PreparedRecord,
  StartedMutationRecord
} from "../server/mutation-ledger-types.js";
import {
  ABSENT_STORY_MUTATION_METHODS,
  PREPARED_DOMAIN_ERRORS,
  PROVIDER_MUTATION_METHODS,
  SETTINGS_MUTATION_METHODS,
  STORY_MUTATION_METHODS,
  isDurableMutationMethod,
  mutationAggregateKind
} from "../server/mutation-ledger-types.js";
import {
  hashMutationPreparedRecordBytes,
  hashMutationStartedRecordBytes
} from "../server/story-manifest-hash.js";
import { storyIdForMutation } from "../server/story-identity.js";
import { V6_MUTATION_ID_PATTERN, V6_MUTATION_ID_PATTERN_SOURCE } from "../server/story-v6-scalars.js";
import { MUTATION_LEDGER_SCHEMA_SHA256 } from "../shared/mutation-ledger-schema-identity.js";
import { assertMutationLedgerSchemaCorpus } from "../scripts/mutation-ledger-schema-validation.js";

interface CorpusCase {
  name: string;
  valid: boolean;
  schemaValid: boolean;
  text: string;
}

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const schemaText = readFileSync(path.join(ROOT, "schema", "mutation-ledger.schema.json"), "utf8");
const corpusText = readFileSync(path.join(ROOT, "schema", "mutation-ledger.corpus.json"), "utf8");
const corpus = JSON.parse(corpusText) as { schemaVersion: number; cases: CorpusCase[] };
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

test("mutation ledger schema artifacts are canonical, hashed, and structurally validated", () => {
  const schema = JSON.parse(schemaText) as Record<string, unknown>;
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(canonicalJson(schema), schemaText);
  assert.equal(canonicalJson(JSON.parse(corpusText) as unknown), corpusText);
  assert.equal(createHash("sha256").update(schemaText).digest("hex"), MUTATION_LEDGER_SCHEMA_SHA256);
  assert.doesNotThrow(() => assertMutationLedgerSchemaCorpus(schema, corpus.cases));
});

for (const fixture of corpus.cases) {
  test(`mutation ledger corpus: ${fixture.name}`, () => {
    if (fixture.valid) {
      const record = parseMutationLedgerRecordText(fixture.text);
      assert.equal(formatMutationLedgerRecord(record), fixture.text);
    } else {
      assert.throws(() => parseMutationLedgerRecordText(fixture.text));
    }
  });
}

test("parsed records and nested results are deeply immutable", () => {
  const record = fixture("prepared-story-local");
  assert.ok(Object.isFrozen(record));
  if (record.kind !== "prepared") assert.fail("Expected prepared fixture");
  assert.ok(Object.isFrozen(record.result));
  if (record.result.kind !== "story" || record.result.summary === null) assert.fail("Expected story result");
  assert.ok(Object.isFrozen(record.result.summary));
});

test("record hashes use exact kind-specific domain separators", () => {
  const started = fixture("started-provider-story") as StartedMutationRecord;
  const prepared = fixture("prepared-story-local") as PreparedRecord;
  const startedBytes = Buffer.from(formatMutationLedgerRecord(started));
  const preparedBytes = Buffer.from(formatMutationLedgerRecord(prepared));
  assert.equal(hashStartedMutationRecord(started), hashMutationStartedRecordBytes(startedBytes));
  assert.equal(hashPreparedMutationRecord(prepared), hashMutationPreparedRecordBytes(preparedBytes));
  assert.notEqual(hashStartedMutationRecord(started), createHash("sha256").update(startedBytes).digest("hex"));
});

test("durable method registry is closed and independently classified", () => {
  const methods: DurableMutationMethod[] = [
    ...STORY_MUTATION_METHODS,
    ...SETTINGS_MUTATION_METHODS,
    "migrateSettingsFormatV1"
  ];
  assert.equal(new Set(methods).size, methods.length);
  for (const method of methods) {
    assert.equal(isDurableMutationMethod(method), true);
    assert.equal(mutationAggregateKind(method), STORY_MUTATION_METHODS.includes(method as never) ? "story" : "settings");
  }
  assert.equal(isDurableMutationMethod("listStories"), false);
});

test("ledger and V6 pointers share the exact ADR001 mutation-ID grammar", () => {
  assert.equal(MUTATION_ID_PATTERN_SOURCE, V6_MUTATION_ID_PATTERN_SOURCE);
  assert.equal(MUTATION_ID_PATTERN, V6_MUTATION_ID_PATTERN);
});

test("create/import story identity uses the frozen SHA-256 Base32 vector", () => {
  const mutationId = `m1.1767225600000.${"d".repeat(32)}`;
  assert.equal(
    storyIdForMutation(mutationId),
    "st1_3wudtnymtwv4c3jmsaksvcgskgvzd5rqqgejj4ymrkykmdt7pvta"
  );
});

test("every story and settings method satisfies exactly its valid prepared matrix", () => {
  const storyBase = rawFixture("prepared-story-local");
  for (const method of STORY_MUTATION_METHODS) {
    if (method === "acknowledgeUnknownOutcomes") continue;
    const provider = PROVIDER_MUTATION_METHODS.includes(method as never);
    const absent = ABSENT_STORY_MUTATION_METHODS.includes(method as never);
    const storyId = absent ? storyIdForMutation(storyBase.key) : "story-one";
    const result = storyBase.result as Record<string, unknown>;
    const summary = result.summary as Record<string, unknown>;
    const value = {
      ...storyBase,
      aggregateKey: `story:${storyId}`,
      method,
      oldStateHash: absent ? "absent" : HASH_A,
      startedRecordHash: provider ? HASH_C : null,
      result: {
        ...result,
        storyId,
        storyRevision: absent ? "00000000000000000001" : result.storyRevision,
        summary: method === "deleteStory" ? null : { ...summary, id: storyId }
      }
    };
    assert.doesNotThrow(() => parseMutationLedgerRecordText(canonicalJson(value)), method);
  }

  const settingsBase = rawFixture("prepared-settings");
  for (const method of SETTINGS_MUTATION_METHODS) {
    const result = settingsBase.result as Record<string, unknown>;
    const value = {
      ...settingsBase,
      method,
      result: method === "discardPendingSettings" ? { ...result, pendingSettingsRevision: null } : result
    };
    assert.doesNotThrow(() => parseMutationLedgerRecordText(canonicalJson(value)), method);
  }
});

test("only the exact prepared-domain error enum is storable", () => {
  const base = rawFixture("prepared-receipt-only-error");
  for (const code of PREPARED_DOMAIN_ERRORS) {
    const provider = code === "provider_failure";
    const value = {
      ...base,
      method: provider ? "continueStory" : "renameStory",
      result: { ...(base.result as Record<string, unknown>), code }
    };
    assert.doesNotThrow(() => parseMutationLedgerRecordText(canonicalJson(value)), code);
  }
  for (const code of [
    "not_found", "forbidden", "resource_busy", "internal", "revision_conflict",
    "receipt_storage_unavailable", "generation_outcome_unknown_acknowledged",
    "settings_edit_requires_data_format_2", "credential_test_requires_activation"
  ]) {
    const value = { ...base, result: { ...(base.result as Record<string, unknown>), code } };
    assert.throws(() => parseMutationLedgerRecordText(canonicalJson(value)), Error, code);
  }
});

test("provider acknowledgement requires a changed story revision result", () => {
  const base = rawFixture("prepared-provider-acknowledgement");
  assert.throws(() => parseMutationLedgerRecordText(canonicalJson({
    ...base,
    result: { kind: "error", code: "conflict", aggregateVersion: { kind: "story", revision: revision() } }
  })));
  assert.throws(() => parseMutationLedgerRecordText(canonicalJson({ ...base, newStateHash: base.oldStateHash })));
});

test("codec rejects fatal UTF-8, BOM, size overflow, and noncanonical bytes before acceptance", () => {
  assert.throws(() => parseMutationLedgerRecordBytes(Uint8Array.of(0xff)), /UTF-8/);
  assert.throws(
    () => parseMutationLedgerRecordBytes(Uint8Array.of(0xef, 0xbb, 0xbf, 0x7b, 0x7d)),
    /UTF-8/
  );
  assert.throws(
    () => parseMutationLedgerRecordBytes(Buffer.alloc(MAX_MUTATION_LEDGER_RECORD_BYTES + 1, 0x20)),
    /size limit/
  );
  const canonical = corpus.cases.find(({ name }) => name === "started-provider-story")!.text;
  assert.throws(() => parseMutationLedgerRecordText(`${canonical} `), /canonical/);
  assert.throws(
    () => parseMutationLedgerRecordText(canonicalJson({ ...rawFixture("started-provider-story"), surprise: true })),
    MutationLedgerFormatError
  );
  assert.throws(
    () => formatMutationLedgerRecord({
      ...fixture("started-provider-story"),
      createdAt: "\ud800"
    } as StartedMutationRecord),
    MutationLedgerFormatError
  );
});

test("4,096 worst-case escaped title scalars fit; one more scalar and oversized bytes fail", () => {
  const valid = corpus.cases.find(({ name }) => name === "prepared-4096-escaped-control-title")!;
  assert.ok(Buffer.byteLength(valid.text) < MAX_MUTATION_LEDGER_RECORD_BYTES);
  assert.doesNotThrow(() => parseMutationLedgerRecordText(valid.text));
  assert.throws(() => parseMutationLedgerRecordText(
    corpus.cases.find(({ name }) => name === "prepared-4097-title-scalars")!.text
  ));
  assert.throws(() => parseMutationLedgerRecordText(
    corpus.cases.find(({ name }) => name === "record-over-32-kib")!.text
  ), /size limit/);
});

function fixture(name: string): MutationLedgerRecord {
  const found = corpus.cases.find((entry) => entry.name === name);
  assert.ok(found);
  return parseMutationLedgerRecordText(found.text);
}

function rawFixture(name: string): Record<string, unknown> {
  const found = corpus.cases.find((entry) => entry.name === name);
  assert.ok(found);
  return JSON.parse(found.text) as Record<string, unknown>;
}

function revision(): string {
  return "00000000000000000002";
}
