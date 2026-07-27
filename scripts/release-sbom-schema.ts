import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv/dist/ajv.js";
import { parseJsonRejectingDuplicateKeys } from "../shared/strict-json.js";

/**
 * The SPDX 2.3 JSON Schema, vendored verbatim from
 * `spdx/spdx-spec` tag `v2.3`, path `schemas/spdx-schema.json`. It is checked
 * in rather than fetched so validation works on a runner with no network, and
 * the digest is pinned so a swapped or truncated copy fails instead of
 * silently weakening the check.
 */
export const SPDX_SCHEMA_FILE = "spdx-2.3.schema.json" as const;
export const SPDX_SCHEMA_SHA256 =
  "239208b7ac287b3cf5d9a9af23f9d69863971102a5e1587a27a398b43490b89b" as const;
const MAX_SPDX_SCHEMA_BYTES = 1024 * 1024;

const REPOSITORY_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function spdxSchemaPath(): string {
  return path.join(REPOSITORY_ROOT, "schema", SPDX_SCHEMA_FILE);
}

export function loadSpdxSchema(): Record<string, unknown> {
  const bytes = readFileSync(spdxSchemaPath());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_SPDX_SCHEMA_BYTES) {
    throw new Error("Vendored SPDX schema is outside its size bound");
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== SPDX_SCHEMA_SHA256) {
    throw new Error("Vendored SPDX schema does not match its reviewed digest");
  }
  const value = parseJsonRejectingDuplicateKeys(bytes.toString("utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Vendored SPDX schema is not a JSON Schema object");
  }
  return value as Record<string, unknown>;
}

/** Compiles once; a release generates five documents against the same schema. */
export function createSpdxValidator(): (value: unknown) => void {
  const schema = loadSpdxSchema();
  const ajv = new Ajv({ allErrors: true, strict: true });
  if (!ajv.validateSchema(schema)) {
    throw new Error(`Vendored SPDX schema is invalid: ${ajv.errorsText(ajv.errors)}`);
  }
  const validate = ajv.compile(schema);
  return (value: unknown): void => {
    if (validate(value)) return;
    throw new Error(`Release SBOM is not a valid SPDX 2.3 document: ${
      ajv.errorsText(validate.errors)
    }`);
  };
}
