import { createHash, createHmac, randomBytes as cryptoRandomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { canonicalJson } from "../../server/canonical-json.js";
import { parseJsonRejectingDuplicateKeys } from "../../server/strict-json.js";
import {
  GEMMA_SCORING_CONTEXT,
  GEMMA_SCORING_REFERENCES,
  type GemmaReplayOperation,
  type GemmaScoringReference
} from "./fixture.js";
import type { ReplayResult, ReplaySample } from "./runner.js";
import {
  GEMMA_EXPECTED_BLIND_SAMPLE_COUNT,
  GEMMA_REPLAY_FIXTURE,
  GEMMA_REPLAY_HARNESS,
  GEMMA_REPLAY_OPERATIONS,
  GEMMA_REPLAY_SCHEMA_VERSION,
  GEMMA_REPLAY_SEEDS,
  GEMMA_RUBRIC_KEYS,
  type GemmaReplayArm
} from "./contract.js";
import { writePrivateJson } from "./private-json-file.js";

const BLIND_MAPPING_SCHEMA_VERSION = 1 as const;
const BLIND_MAPPING_SECRET_BYTES = 32;
const BLIND_ID_PATTERN = /^blind-\d{2}$/u;
const FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const MAPPING_DIGEST_PATTERN = /^hmac-sha256:[a-f0-9]{64}$/u;

export interface BlindSample {
  readonly blindId: string;
  readonly output: string;
  readonly referenceId: string;
}

/** Bytes used to create a private blind mapping. Tests can inject a fixed
 * source. Production callers use cryptographic random bytes. */
export type BlindEntropy = (length: number) => Uint8Array;

export interface BlindPackOptions {
  readonly entropy?: BlindEntropy;
}

export type BlindReference = Omit<GemmaScoringReference, "operation">;

export interface BlindPack {
  readonly schemaVersion: 1;
  readonly harness: typeof GEMMA_REPLAY_HARNESS;
  readonly fixture: typeof GEMMA_REPLAY_FIXTURE;
  readonly rubric: readonly (typeof GEMMA_RUBRIC_KEYS[number])[];
  readonly context: typeof GEMMA_SCORING_CONTEXT;
  readonly references: Readonly<Record<string, BlindReference>>;
  readonly samples: readonly BlindSample[];
}

export interface BlindReferenceBinding {
  readonly referenceId: string;
  readonly operation: GemmaReplayOperation;
}

export interface BlindMappingEntry {
  readonly blindId: string;
  readonly referenceId: string;
  readonly pairId: string;
  readonly operation: GemmaReplayOperation;
  readonly seed: (typeof GEMMA_REPLAY_SEEDS)[number];
  readonly arm: GemmaReplayArm;
  readonly outputFingerprint: string;
}

export interface BlindMapping {
  readonly schemaVersion: typeof BLIND_MAPPING_SCHEMA_VERSION;
  readonly packFingerprint: string;
  readonly replayFingerprint: string;
  readonly mappingSecret: string;
  /** Published in final evidence only. It is not part of the blind pack. */
  readonly shuffleSeed: number;
  readonly referenceBindings: readonly BlindReferenceBinding[];
  readonly assignments: readonly BlindMappingEntry[];
  readonly mappingDigest: string;
}

export interface BlindPackArtifacts {
  readonly pack: BlindPack;
  readonly mapping: BlindMapping;
}

export interface BlindScoreInputs {
  readonly pack: BlindPack;
  readonly mapping: BlindMapping;
}

/** Create only the scorer-facing pack. The CLI uses
 * createBlindPackArtifacts so it can write the private mapping beside the
 * pack. */
export function createBlindPack(
  result: ReplayResult,
  options: BlindPackOptions = {}
): BlindPack {
  return createBlindPackArtifacts(result, options).pack;
}

/** Create the scorer-facing pack and its separate private mapping. */
export function createBlindPackArtifacts(
  result: ReplayResult,
  options: BlindPackOptions = {}
): BlindPackArtifacts {
  const secret = mappingSecret(options.entropy ?? randomEntropy);
  const referenceIds = referenceIdsFor(secret);
  const assignments = shuffledAssignments(result, secret, referenceIds);
  const pack: BlindPack = {
    schemaVersion: GEMMA_REPLAY_SCHEMA_VERSION,
    harness: GEMMA_REPLAY_HARNESS,
    fixture: GEMMA_REPLAY_FIXTURE,
    rubric: GEMMA_RUBRIC_KEYS,
    context: GEMMA_SCORING_CONTEXT,
    references: blindReferences(referenceIds),
    samples: assignments.map((assignment, index) => ({
      blindId: blindId(index),
      output: assignment.output,
      referenceId: assignment.referenceId
    }))
  };
  const mappingWithoutDigest = {
    schemaVersion: BLIND_MAPPING_SCHEMA_VERSION,
    packFingerprint: fingerprint(pack),
    replayFingerprint: fingerprint(result),
    mappingSecret: secret.toString("hex"),
    shuffleSeed: secret.readUInt32BE(0),
    referenceBindings: referenceBindings(referenceIds),
    assignments: assignments.map((assignment, index) => mappingEntry(assignment, blindId(index)))
  } satisfies Omit<BlindMapping, "mappingDigest">;
  return {
    pack,
    mapping: {
      ...mappingWithoutDigest,
      mappingDigest: mappingDigest(secret, mappingWithoutDigest)
    }
  };
}

export async function writeBlindPack(pathname: string, pack: BlindPack): Promise<void> {
  await writePrivateJson(pathname, pack);
}

export async function writeBlindMapping(pathname: string, mapping: BlindMapping): Promise<void> {
  await writePrivateJson(pathname, mapping);
}

export async function readBlindPack(pathname: string): Promise<BlindPack> {
  return parseBlindPack(parseJsonRejectingDuplicateKeys(
    await readFile(pathname, "utf8"),
    "Gemma blind pack"
  ));
}

export async function readBlindMapping(pathname: string): Promise<BlindMapping> {
  return parseBlindMapping(parseJsonRejectingDuplicateKeys(
    await readFile(pathname, "utf8"),
    "Gemma blind mapping"
  ));
}

export function resolveScoreInputs(
  result: ReplayResult,
  inputs: BlindScoreInputs
): BlindScoreInputs {
  verifyMapping(result, inputs.pack, inputs.mapping);
  return inputs;
}

function blindOutput(
  sample: ReplaySample,
  side: GemmaReplayArm,
  referenceIds: ReadonlyMap<GemmaReplayOperation, string>
): BlindAssignment {
  return {
    key: `${sample.pairId}:${side}`,
    referenceId: referenceIds.get(sample.operation)!,
    pairId: sample.pairId,
    operation: sample.operation,
    seed: sample.seed,
    arm: side,
    output: sample[side].output,
    outputFingerprint: sample[side].outputFingerprint
  };
}

interface BlindAssignment {
  readonly key: string;
  readonly referenceId: string;
  readonly pairId: string;
  readonly operation: GemmaReplayOperation;
  readonly seed: number;
  readonly arm: GemmaReplayArm;
  readonly output: string;
  readonly outputFingerprint: string;
}

function mappingEntry(assignment: BlindAssignment, id: string): BlindMappingEntry {
  return {
    blindId: id,
    referenceId: assignment.referenceId,
    pairId: assignment.pairId,
    operation: assignment.operation,
    seed: assignment.seed as (typeof GEMMA_REPLAY_SEEDS)[number],
    arm: assignment.arm,
    outputFingerprint: assignment.outputFingerprint
  };
}

function shuffledAssignments(
  result: ReplayResult,
  secret: Uint8Array,
  referenceIds: ReadonlyMap<GemmaReplayOperation, string> = referenceIdsFor(secret)
): BlindAssignment[] {
  const values = result.samples.flatMap((sample) => [
    blindOutput(sample, "baseline", referenceIds),
    blindOutput(sample, "candidate", referenceIds)
  ]);
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swap = secretIndex(secret, index, index + 1);
    const value = values[index]!;
    values[index] = values[swap]!;
    values[swap] = value;
  }
  return values;
}

function secretIndex(secret: Uint8Array, position: number, bound: number): number {
  const limit = 0x1_0000_0000 - (0x1_0000_0000 % bound);
  for (let attempt = 0; ; attempt += 1) {
    const digest = createHmac("sha256", secret)
      .update(`blind-order-v1\0${position}\0${attempt}`, "utf8")
      .digest();
    const value = digest.readUInt32BE(0);
    if (value < limit) return value % bound;
  }
}

function blindId(index: number): string {
  return `blind-${String(index + 1).padStart(2, "0")}`;
}

function referenceId(index: number): string {
  return `ref-${String(index + 1).padStart(2, "0")}`;
}

function referenceIdsFor(secret: Uint8Array): ReadonlyMap<GemmaReplayOperation, string> {
  const ids = GEMMA_REPLAY_OPERATIONS.map((_, index) => referenceId(index));
  for (let index = ids.length - 1; index > 0; index -= 1) {
    const swap = secretIndex(secret, ids.length + index, index + 1);
    const value = ids[index]!;
    ids[index] = ids[swap]!;
    ids[swap] = value;
  }
  return new Map(GEMMA_REPLAY_OPERATIONS.map((operation, index) => [operation, ids[index]!]));
}

function blindReferences(
  referenceIds: ReadonlyMap<GemmaReplayOperation, string>
): Readonly<Record<string, BlindReference>> {
  return Object.fromEntries(
    Object.entries(GEMMA_SCORING_REFERENCES).map(([operation, reference]) => {
      const { operation: _operation, ...blindReference } = reference;
      return [referenceIds.get(operation as GemmaReplayOperation)!, blindReference];
    })
  ) as Readonly<Record<string, BlindReference>>;
}

function referenceBindings(
  referenceIds: ReadonlyMap<GemmaReplayOperation, string>
): BlindReferenceBinding[] {
  return GEMMA_REPLAY_OPERATIONS.map((operation) => ({
    referenceId: referenceIds.get(operation)!,
    operation
  }));
}

function verifyMapping(result: ReplayResult, pack: BlindPack, mapping: BlindMapping): void {
  const secret = parseMappingSecret(mapping.mappingSecret);
  if (mapping.schemaVersion !== BLIND_MAPPING_SCHEMA_VERSION) {
    throw new Error("blind mapping schema version is invalid");
  }
  if (!FINGERPRINT_PATTERN.test(mapping.packFingerprint)) {
    throw new Error("blind mapping pack fingerprint is invalid");
  }
  if (!FINGERPRINT_PATTERN.test(mapping.replayFingerprint)) {
    throw new Error("blind mapping replay fingerprint is invalid");
  }
  if (mapping.packFingerprint !== fingerprint(pack)) {
    throw new Error("blind mapping does not belong to the blind pack");
  }
  if (mapping.replayFingerprint !== fingerprint(result)) {
    throw new Error("blind mapping does not belong to the replay");
  }
  if (mapping.shuffleSeed !== secret.readUInt32BE(0)) {
    throw new Error("blind mapping shuffle seed is invalid");
  }
  if (mapping.mappingDigest !== mappingDigest(secret, withoutMappingDigest(mapping))) {
    throw new Error("blind mapping digest is invalid");
  }
  const referenceIds = referenceIdsFor(secret);
  const expectedReferenceBindings = referenceBindings(referenceIds);
  if (canonicalJson(mapping.referenceBindings) !== canonicalJson(expectedReferenceBindings)) {
    throw new Error("blind mapping reference bindings do not match the replay");
  }
  const expectedAssignments = shuffledAssignments(result, secret).map((assignment, index) =>
    mappingEntry(assignment, blindId(index))
  );
  if (canonicalJson(mapping.assignments) !== canonicalJson(expectedAssignments)) {
    throw new Error("blind mapping assignments do not match the replay");
  }
  if (mapping.assignments.length !== pack.samples.length) {
    throw new Error("blind mapping does not match the blind pack sample count");
  }
  const samples = new Map(pack.samples.map((sample) => [sample.blindId, sample]));
  for (const assignment of mapping.assignments) {
    const sample = samples.get(assignment.blindId);
    if (
      sample === undefined
      || sample.referenceId !== assignment.referenceId
      || textFingerprint(sample.output) !== assignment.outputFingerprint
    ) {
      throw new Error("blind mapping does not match the blind pack outputs");
    }
  }
}

function withoutMappingDigest(mapping: BlindMapping): Omit<BlindMapping, "mappingDigest"> {
  const { mappingDigest: _mappingDigest, ...withoutDigest } = mapping;
  return withoutDigest;
}

export function parseBlindPack(value: unknown): BlindPack {
  const pack = requireRecord(value, "blind pack");
  requireKeys(pack, ["schemaVersion", "harness", "fixture", "rubric", "context", "references", "samples"], "blind pack");
  if (pack.schemaVersion !== GEMMA_REPLAY_SCHEMA_VERSION) throw new Error("blind pack schemaVersion is invalid");
  if (pack.harness !== GEMMA_REPLAY_HARNESS) throw new Error("blind pack harness is invalid");
  if (pack.fixture !== GEMMA_REPLAY_FIXTURE) throw new Error("blind pack fixture is invalid");
  if (!Array.isArray(pack.rubric) || canonicalJson(pack.rubric) !== canonicalJson(GEMMA_RUBRIC_KEYS)) {
    throw new Error("blind pack rubric is invalid");
  }
  if (!isRecord(pack.context) || !isRecord(pack.references)) throw new Error("blind pack context or references is invalid");
  const referenceIds = Object.keys(pack.references).sort();
  if (
    referenceIds.length !== GEMMA_REPLAY_OPERATIONS.length
    || referenceIds.some((id, index) => id !== referenceId(index))
  ) {
    throw new Error("blind pack references must contain opaque reference IDs");
  }
  for (const id of referenceIds) {
    const reference = requireRecord(pack.references[id], `blind pack references.${id}`);
    if (Object.hasOwn(reference, "operation")) throw new Error(`blind pack references.${id} must not identify an operation`);
  }
  if (!Array.isArray(pack.samples) || pack.samples.length !== GEMMA_EXPECTED_BLIND_SAMPLE_COUNT) {
    throw new Error(`blind pack samples must contain ${GEMMA_EXPECTED_BLIND_SAMPLE_COUNT} samples`);
  }
  const ids = new Set<string>();
  const samples = pack.samples.map((value, index) => {
    const sample = requireRecord(value, `blind pack samples[${index}]`);
    requireKeys(sample, ["blindId", "output", "referenceId"], `blind pack samples[${index}]`);
    if (typeof sample.blindId !== "string" || !BLIND_ID_PATTERN.test(sample.blindId) || ids.has(sample.blindId)) {
      throw new Error(`blind pack samples[${index}].blindId is invalid`);
    }
    if (typeof sample.output !== "string" || sample.output.length === 0) throw new Error(`blind pack samples[${index}].output is invalid`);
    if (typeof sample.referenceId !== "string" || !referenceIds.includes(sample.referenceId)) {
      throw new Error(`blind pack samples[${index}].referenceId is invalid`);
    }
    ids.add(sample.blindId);
    return { blindId: sample.blindId, output: sample.output, referenceId: sample.referenceId };
  });
  const expectedIds = new Set(samples.map((_, index) => blindId(index)));
  if (ids.size !== expectedIds.size || [...ids].some((id) => !expectedIds.has(id))) throw new Error("blind pack samples must contain every blind id exactly once");
  return {
    schemaVersion: GEMMA_REPLAY_SCHEMA_VERSION,
    harness: GEMMA_REPLAY_HARNESS,
    fixture: GEMMA_REPLAY_FIXTURE,
    rubric: [...GEMMA_RUBRIC_KEYS],
    context: pack.context as typeof GEMMA_SCORING_CONTEXT,
    references: pack.references as Readonly<Record<string, BlindReference>>,
    samples
  };
}

export function parseBlindMapping(value: unknown): BlindMapping {
  const mapping = requireRecord(value, "blind mapping");
  requireKeys(mapping, ["schemaVersion", "packFingerprint", "replayFingerprint", "mappingSecret", "shuffleSeed", "referenceBindings", "assignments", "mappingDigest"], "blind mapping");
  if (mapping.schemaVersion !== BLIND_MAPPING_SCHEMA_VERSION) throw new Error("blind mapping schemaVersion is invalid");
  if (typeof mapping.packFingerprint !== "string" || !FINGERPRINT_PATTERN.test(mapping.packFingerprint)) throw new Error("blind mapping packFingerprint is invalid");
  if (typeof mapping.replayFingerprint !== "string" || !FINGERPRINT_PATTERN.test(mapping.replayFingerprint)) throw new Error("blind mapping replayFingerprint is invalid");
  const secret = parseMappingSecret(mapping.mappingSecret);
  if (typeof mapping.shuffleSeed !== "number" || !Number.isSafeInteger(mapping.shuffleSeed)) throw new Error("blind mapping shuffleSeed must be an integer");
  if (!Array.isArray(mapping.referenceBindings) || mapping.referenceBindings.length !== GEMMA_REPLAY_OPERATIONS.length) {
    throw new Error("blind mapping referenceBindings are invalid");
  }
  const referenceBindingIds = new Set<string>();
  const referenceBindingOperations = new Set<string>();
  const referenceBindings = mapping.referenceBindings.map((value, index) => {
    const binding = requireRecord(value, `blind mapping referenceBindings[${index}]`);
    requireKeys(binding, ["referenceId", "operation"], `blind mapping referenceBindings[${index}]`);
    if (typeof binding.referenceId !== "string" || !/^ref-\d{2}$/u.test(binding.referenceId) || referenceBindingIds.has(binding.referenceId)) {
      throw new Error(`blind mapping referenceBindings[${index}].referenceId is invalid`);
    }
    if (typeof binding.operation !== "string" || !GEMMA_REPLAY_OPERATIONS.includes(binding.operation as GemmaReplayOperation) || referenceBindingOperations.has(binding.operation)) {
      throw new Error(`blind mapping referenceBindings[${index}].operation is invalid`);
    }
    referenceBindingIds.add(binding.referenceId);
    referenceBindingOperations.add(binding.operation);
    return {
      referenceId: binding.referenceId,
      operation: binding.operation as GemmaReplayOperation
    };
  });
  if (!Array.isArray(mapping.assignments) || mapping.assignments.length !== GEMMA_EXPECTED_BLIND_SAMPLE_COUNT) throw new Error(`blind mapping assignments must contain ${GEMMA_EXPECTED_BLIND_SAMPLE_COUNT} entries`);
  const ids = new Set<string>();
  const assignments = mapping.assignments.map((value, index) => {
    const assignment = requireRecord(value, `blind mapping assignments[${index}]`);
    requireKeys(assignment, ["blindId", "referenceId", "pairId", "operation", "seed", "arm", "outputFingerprint"], `blind mapping assignments[${index}]`);
    if (typeof assignment.blindId !== "string" || !BLIND_ID_PATTERN.test(assignment.blindId) || ids.has(assignment.blindId)) throw new Error(`blind mapping assignments[${index}].blindId is invalid`);
    if (typeof assignment.referenceId !== "string" || !referenceBindingIds.has(assignment.referenceId)) throw new Error(`blind mapping assignments[${index}].referenceId is invalid`);
    if (typeof assignment.pairId !== "string") throw new Error(`blind mapping assignments[${index}].pairId is invalid`);
    if (assignment.operation !== "retake" && assignment.operation !== "continue") throw new Error(`blind mapping assignments[${index}].operation is invalid`);
    if (typeof assignment.seed !== "number" || !GEMMA_REPLAY_SEEDS.includes(assignment.seed as (typeof GEMMA_REPLAY_SEEDS)[number])) throw new Error(`blind mapping assignments[${index}].seed is invalid`);
    if (assignment.arm !== "baseline" && assignment.arm !== "candidate") throw new Error(`blind mapping assignments[${index}].arm is invalid`);
    if (typeof assignment.outputFingerprint !== "string" || !FINGERPRINT_PATTERN.test(assignment.outputFingerprint)) throw new Error(`blind mapping assignments[${index}].outputFingerprint is invalid`);
    ids.add(assignment.blindId);
    return {
      blindId: assignment.blindId,
      referenceId: assignment.referenceId,
      pairId: assignment.pairId,
      operation: assignment.operation as GemmaReplayOperation,
      seed: assignment.seed as (typeof GEMMA_REPLAY_SEEDS)[number],
      arm: assignment.arm as GemmaReplayArm,
      outputFingerprint: assignment.outputFingerprint
    };
  });
  const result: BlindMapping = {
    schemaVersion: BLIND_MAPPING_SCHEMA_VERSION,
    packFingerprint: mapping.packFingerprint,
    replayFingerprint: mapping.replayFingerprint,
    mappingSecret: mapping.mappingSecret as string,
    shuffleSeed: mapping.shuffleSeed,
    referenceBindings,
    assignments,
    mappingDigest: mapping.mappingDigest as string
  };
  if (!MAPPING_DIGEST_PATTERN.test(result.mappingDigest)) throw new Error("blind mapping digest is invalid");
  if (result.shuffleSeed !== secret.readUInt32BE(0)) throw new Error("blind mapping shuffleSeed is invalid");
  if (result.mappingDigest !== mappingDigest(secret, withoutMappingDigest(result))) throw new Error("blind mapping digest is invalid");
  return result;
}

function mappingSecret(entropy: BlindEntropy): Buffer {
  const bytes = entropy(BLIND_MAPPING_SECRET_BYTES);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== BLIND_MAPPING_SECRET_BYTES) throw new Error(`blind mapping entropy must provide ${BLIND_MAPPING_SECRET_BYTES} bytes`);
  return Buffer.from(bytes);
}

function randomEntropy(length: number): Uint8Array {
  return cryptoRandomBytes(length);
}

function parseMappingSecret(value: unknown): Buffer {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw new Error("blind mapping mappingSecret must contain 32-byte hexadecimal entropy");
  return Buffer.from(value, "hex");
}

function mappingDigest(secret: Uint8Array, mapping: Omit<BlindMapping, "mappingDigest">): string {
  return `hmac-sha256:${createHmac("sha256", secret).update(canonicalJson(mapping), "utf8").digest("hex")}`;
}

function fingerprint(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

function textFingerprint(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requireKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const received = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (received.length !== expected.length || received.some((key, index) => key !== expected[index])) throw new Error(`${label} has unsupported or missing fields`);
}
