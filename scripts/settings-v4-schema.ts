import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../server/canonical-json.js";
import { SETTINGS_DOCUMENT_V2_HASH_DOMAIN, SETTINGS_STATE_V2_HASH_DOMAIN } from "../server/settings-v2-hash.js";
import {
  INITIAL_SETTINGS_DOCUMENT_V4_HASH,
  INITIAL_SETTINGS_DOCUMENT_V4_SHA256,
  INITIAL_SETTINGS_DOCUMENT_V4_TEXT,
  INITIAL_SETTINGS_STATE_V4_HASH,
  INITIAL_SETTINGS_STATE_V4_SHA256,
  INITIAL_SETTINGS_STATE_V4_TEXT
} from "../server/settings-v4-initial-vectors.js";
import { assertExact } from "./generated-artifact.js";
import { settingsV4Corpus } from "./settings-v4-schema-corpus.js";
import { settingsV4Schema } from "./settings-v4-schema-definition.js";
import { assertSettingsV4SchemaCorpus } from "./settings-v4-schema-validation.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCHEMA_FILE = path.join(ROOT, "schema", "settings-v4.schema.json");
const CORPUS_FILE = path.join(ROOT, "schema", "settings-v4.corpus.json");
const VECTORS_FILE = path.join(ROOT, "schema", "settings-v4.hash-vectors.json");
const IDENTITY_FILE = path.join(ROOT, "shared", "settings-v4-schema-identity.ts");

const schema = settingsV4Schema();
const cases = settingsV4Corpus();
assertSettingsV4SchemaCorpus(schema, cases);
const schemaText = canonicalJson(schema);
const corpusText = canonicalJson({ schemaVersion: 1, cases });
const vectorsText = canonicalJson({
  schemaVersion: 1,
  vectors: {
    initialDocumentV4: {
      canonicalText: INITIAL_SETTINGS_DOCUMENT_V4_TEXT,
      sha256: INITIAL_SETTINGS_DOCUMENT_V4_SHA256,
      hashDomain: SETTINGS_DOCUMENT_V2_HASH_DOMAIN,
      domainHash: INITIAL_SETTINGS_DOCUMENT_V4_HASH
    },
    initialStateV4: {
      canonicalText: INITIAL_SETTINGS_STATE_V4_TEXT,
      sha256: INITIAL_SETTINGS_STATE_V4_SHA256,
      hashDomain: SETTINGS_STATE_V2_HASH_DOMAIN,
      domainHash: INITIAL_SETTINGS_STATE_V4_HASH
    }
  }
});
const identityText = [
  "/** SHA-256 identities of the exact canonical schema-4 predecessor artifacts. */",
  `export const SETTINGS_V4_SCHEMA_SHA256 = "${sha256(schemaText)}" as const;`,
  `export const SETTINGS_V4_CORPUS_SHA256 = "${sha256(corpusText)}" as const;`,
  `export const SETTINGS_V4_HASH_VECTORS_SHA256 = "${sha256(vectorsText)}" as const;`,
  ""
].join("\n");

const ARTIFACT_OPTIONS = {
  root: ROOT,
  label: "settings v4",
  writeCommand: "npx tsx scripts/settings-v4-schema.ts --write"
};

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
    assertExact(SCHEMA_FILE, schemaText, ARTIFACT_OPTIONS),
    assertExact(CORPUS_FILE, corpusText, ARTIFACT_OPTIONS),
    assertExact(VECTORS_FILE, vectorsText, ARTIFACT_OPTIONS),
    assertExact(IDENTITY_FILE, identityText, ARTIFACT_OPTIONS)
  ]);
} else {
  throw new Error("Usage: tsx scripts/settings-v4-schema.ts --write|--check");
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
