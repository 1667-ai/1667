import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../server/canonical-json.js";
import { mutationLedgerCorpus } from "./mutation-ledger-schema-corpus.js";
import { mutationLedgerSchema } from "./mutation-ledger-schema-definition.js";
import { assertMutationLedgerSchemaCorpus } from "./mutation-ledger-schema-validation.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCHEMA_FILE = path.join(ROOT, "schema", "mutation-ledger.schema.json");
const CORPUS_FILE = path.join(ROOT, "schema", "mutation-ledger.corpus.json");
const IDENTITY_FILE = path.join(ROOT, "shared", "mutation-ledger-schema-identity.ts");

const schema = mutationLedgerSchema();
const cases = mutationLedgerCorpus();
assertMutationLedgerSchemaCorpus(schema, cases);
const schemaText = canonicalJson(schema);
const corpusText = canonicalJson({ schemaVersion: 1, cases });
const schemaHash = createHash("sha256").update(schemaText, "utf8").digest("hex");
const identityText = [
  "/** SHA-256 of the exact canonical Draft 2020-12 mutation ledger schema artifact. */",
  `export const MUTATION_LEDGER_SCHEMA_SHA256 = "${schemaHash}" as const;`,
  ""
].join("\n");

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
    assertExact(SCHEMA_FILE, schemaText),
    assertExact(CORPUS_FILE, corpusText),
    assertExact(IDENTITY_FILE, identityText)
  ]);
} else {
  throw new Error("Usage: tsx scripts/mutation-ledger-schema.ts --write|--check");
}

async function assertExact(file: string, expected: string): Promise<void> {
  let actual: string;
  try {
    actual = await readFile(file, "utf8");
  } catch (error) {
    throw new Error(`Generated mutation ledger artifact is missing: ${path.relative(ROOT, file)}`, { cause: error });
  }
  if (actual !== expected) {
    throw new Error(
      `Generated mutation ledger artifact is stale: ${path.relative(ROOT, file)}; `
      + "run npx tsx scripts/mutation-ledger-schema.ts --write"
    );
  }
}
