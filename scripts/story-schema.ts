import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../server/canonical-json.js";
import { assertExact } from "./generated-artifact.js";
import { storyManifestCorpus } from "./story-schema-corpus.js";
import { storyManifestSchema } from "./story-schema-definition.js";
import { assertStorySchemaCorpus } from "./story-schema-validation.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCHEMA_FILE = path.join(ROOT, "schema", "story-manifest.schema.json");
const CORPUS_FILE = path.join(ROOT, "schema", "story-manifest.corpus.json");
const IDENTITY_FILE = path.join(ROOT, "shared", "story-schema-identity.ts");

const schema = storyManifestSchema();
const cases = storyManifestCorpus();
assertStorySchemaCorpus(schema, cases);
const schemaText = canonicalJson(schema);
const corpusText = canonicalJson({ schemaVersion: 1, cases });
const schemaHash = createHash("sha256").update(schemaText, "utf8").digest("hex");
const identityText = [
  "/** SHA-256 of the exact canonical Draft 2020-12 story manifest schema artifact. */",
  `export const STORY_SCHEMA_SHA256 = "${schemaHash}" as const;`,
  ""
].join("\n");

const ARTIFACT_OPTIONS = { root: ROOT, label: "story schema", writeCommand: "npm run schema:write" };

const mode = process.argv[2];
if (mode === "--write") {
  await mkdir(path.dirname(SCHEMA_FILE), { recursive: true });
  await Promise.all([
    writeFile(SCHEMA_FILE, schemaText),
    writeFile(CORPUS_FILE, corpusText),
    writeFile(IDENTITY_FILE, identityText)
  ]);
} else if (mode === "--check") {
  await Promise.all([
    assertExact(SCHEMA_FILE, schemaText, ARTIFACT_OPTIONS),
    assertExact(CORPUS_FILE, corpusText, ARTIFACT_OPTIONS),
    assertExact(IDENTITY_FILE, identityText, ARTIFACT_OPTIONS)
  ]);
} else {
  throw new Error("Usage: tsx scripts/story-schema.ts --write|--check");
}
