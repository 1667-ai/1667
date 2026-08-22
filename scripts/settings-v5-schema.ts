import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../server/canonical-json.js";
import { SETTINGS_DOCUMENT_V2_HASH_DOMAIN, SETTINGS_STATE_V2_HASH_DOMAIN } from "../server/settings-v2-hash.js";
import {
  INITIAL_SETTINGS_DOCUMENT_V5_HASH,
  INITIAL_SETTINGS_DOCUMENT_V5_SHA256,
  INITIAL_SETTINGS_DOCUMENT_V5_TEXT,
  INITIAL_SETTINGS_STATE_V5_HASH,
  INITIAL_SETTINGS_STATE_V5_SHA256,
  INITIAL_SETTINGS_STATE_V5_TEXT
} from "../server/settings-v5-initial-vectors.js";
import { assertExact } from "./generated-artifact.js";
import { settingsV5Corpus } from "./settings-v5-schema-corpus.js";
import { settingsV5Schema } from "./settings-v5-schema-definition.js";
import { assertSettingsV5SchemaCorpus } from "./settings-v5-schema-validation.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCHEMA_FILE = path.join(ROOT, "schema", "settings-v5.schema.json");
const CORPUS_FILE = path.join(ROOT, "schema", "settings-v5.corpus.json");
const VECTORS_FILE = path.join(ROOT, "schema", "settings-v5.hash-vectors.json");
const IDENTITY_FILE = path.join(ROOT, "shared", "settings-v5-schema-identity.ts");

const schema = settingsV5Schema();
const cases = settingsV5Corpus();
assertSettingsV5SchemaCorpus(schema, cases);
const schemaText = canonicalJson(schema);
const corpusText = canonicalJson({ schemaVersion: 1, cases });
const vectorsText = canonicalJson({
  schemaVersion: 1,
  vectors: {
    initialDocumentV5: {
      canonicalText: INITIAL_SETTINGS_DOCUMENT_V5_TEXT,
      sha256: INITIAL_SETTINGS_DOCUMENT_V5_SHA256,
      hashDomain: SETTINGS_DOCUMENT_V2_HASH_DOMAIN,
      domainHash: INITIAL_SETTINGS_DOCUMENT_V5_HASH
    },
    initialStateV5: {
      canonicalText: INITIAL_SETTINGS_STATE_V5_TEXT,
      sha256: INITIAL_SETTINGS_STATE_V5_SHA256,
      hashDomain: SETTINGS_STATE_V2_HASH_DOMAIN,
      domainHash: INITIAL_SETTINGS_STATE_V5_HASH
    }
  }
});
const identityText = [
  "/** SHA-256 identities of the exact canonical schema-5 artifacts. */",
  `export const SETTINGS_V5_SCHEMA_SHA256 = "${sha256(schemaText)}" as const;`,
  `export const SETTINGS_V5_CORPUS_SHA256 = "${sha256(corpusText)}" as const;`,
  `export const SETTINGS_V5_HASH_VECTORS_SHA256 = "${sha256(vectorsText)}" as const;`,
  ""
].join("\n");

const ARTIFACT_OPTIONS = {
  root: ROOT,
  label: "settings v5",
  writeCommand: "npx tsx scripts/settings-v5-schema.ts --write"
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
  throw new Error("Usage: tsx scripts/settings-v5-schema.ts --write|--check");
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
