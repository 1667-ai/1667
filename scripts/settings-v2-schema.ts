import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../server/canonical-json.js";
import {
  ABSENT_SETTINGS_V1_HASH,
  ABSENT_SETTINGS_V1_TEXT
} from "../server/settings-v1-codec.js";
import {
  INITIAL_SETTINGS_DOCUMENT_V2_HASH,
  INITIAL_SETTINGS_DOCUMENT_V2_SHA256,
  INITIAL_SETTINGS_DOCUMENT_V2_TEXT,
  INITIAL_SETTINGS_STATE_V2_HASH,
  INITIAL_SETTINGS_STATE_V2_SHA256,
  INITIAL_SETTINGS_STATE_V2_TEXT
} from "../server/settings-v2-default.js";
import {
  SETTINGS_DOCUMENT_V2_HASH_DOMAIN,
  SETTINGS_STATE_V2_HASH_DOMAIN
} from "../server/settings-v2-hash.js";
import { settingsV2Corpus } from "./settings-v2-schema-corpus.js";
import { settingsV2Schema } from "./settings-v2-schema-definition.js";
import { assertSettingsV2SchemaCorpus } from "./settings-v2-schema-validation.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCHEMA_FILE = path.join(ROOT, "schema", "settings-v2.schema.json");
const CORPUS_FILE = path.join(ROOT, "schema", "settings-v2.corpus.json");
const VECTORS_FILE = path.join(ROOT, "schema", "settings-v2.hash-vectors.json");
const IDENTITY_FILE = path.join(ROOT, "shared", "settings-v2-schema-identity.ts");

const schema = settingsV2Schema();
const cases = settingsV2Corpus();
assertSettingsV2SchemaCorpus(schema, cases);
const schemaText = canonicalJson(schema);
const corpusText = canonicalJson({ schemaVersion: 1, cases });
const vectorsText = canonicalJson({
  schemaVersion: 1,
  vectors: {
    absentSettingsV1: {
      canonicalText: ABSENT_SETTINGS_V1_TEXT,
      sha256: ABSENT_SETTINGS_V1_HASH
    },
    initialDocumentV2: {
      canonicalText: INITIAL_SETTINGS_DOCUMENT_V2_TEXT,
      sha256: INITIAL_SETTINGS_DOCUMENT_V2_SHA256,
      hashDomain: SETTINGS_DOCUMENT_V2_HASH_DOMAIN,
      domainHash: INITIAL_SETTINGS_DOCUMENT_V2_HASH
    },
    initialStateV2: {
      canonicalText: INITIAL_SETTINGS_STATE_V2_TEXT,
      sha256: INITIAL_SETTINGS_STATE_V2_SHA256,
      hashDomain: SETTINGS_STATE_V2_HASH_DOMAIN,
      domainHash: INITIAL_SETTINGS_STATE_V2_HASH
    }
  }
});
const identityText = [
  "/** SHA-256 identities of the exact canonical ADR003 Release A generated artifacts. */",
  `export const SETTINGS_V2_SCHEMA_SHA256 = "${sha256(schemaText)}" as const;`,
  `export const SETTINGS_V2_CORPUS_SHA256 = "${sha256(corpusText)}" as const;`,
  `export const SETTINGS_V2_HASH_VECTORS_SHA256 = "${sha256(vectorsText)}" as const;`,
  ""
].join("\n");

const mode = process.argv[2];
if (mode === "--write") {
  await mkdir(path.dirname(SCHEMA_FILE), { recursive: true });
  await Promise.all([
    writeFile(SCHEMA_FILE, schemaText),
    writeFile(CORPUS_FILE, corpusText),
    writeFile(VECTORS_FILE, vectorsText),
    writeFile(IDENTITY_FILE, identityText)
  ]);
} else if (mode === "--check") {
  await Promise.all([
    assertExact(SCHEMA_FILE, schemaText),
    assertExact(CORPUS_FILE, corpusText),
    assertExact(VECTORS_FILE, vectorsText),
    assertExact(IDENTITY_FILE, identityText)
  ]);
} else {
  throw new Error("Usage: tsx scripts/settings-v2-schema.ts --write|--check");
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function assertExact(file: string, expected: string): Promise<void> {
  let actual: string;
  try {
    actual = await readFile(file, "utf8");
  } catch (error) {
    throw new Error(`Generated settings v2 artifact is missing: ${path.relative(ROOT, file)}`, { cause: error });
  }
  if (actual !== expected) {
    throw new Error(
      `Generated settings v2 artifact is stale: ${path.relative(ROOT, file)}; `
      + "run npx tsx scripts/settings-v2-schema.ts --write"
    );
  }
}
