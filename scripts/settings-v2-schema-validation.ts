import Ajv2020 from "ajv/dist/2020.js";
import type { SettingsV2CorpusCase } from "./settings-v2-schema-corpus.js";

/** Structural schema verdicts are pinned separately from runtime-only
 * canonical-byte, NFC, URL-security, reference, hash, and role-matrix rules. */
export function assertSettingsV2SchemaCorpus(
  schema: Record<string, unknown>,
  cases: readonly SettingsV2CorpusCase[]
): void {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  if (!ajv.validateSchema(schema)) {
    throw new Error(`Settings v2 JSON Schema is invalid: ${ajv.errorsText(ajv.errors)}`);
  }
  const validate = ajv.compile(schema);
  for (const fixture of cases) {
    let instance: unknown;
    let parsed = true;
    try {
      instance = JSON.parse(fixture.text) as unknown;
    } catch {
      parsed = false;
    }
    const actual = parsed && validate(instance) === true;
    if (actual !== fixture.schemaValid) {
      const detail = parsed ? ajv.errorsText(validate.errors) : "not valid JSON text";
      throw new Error(
        `Settings schema corpus mismatch for ${fixture.name}: `
        + `expected schemaValid=${fixture.schemaValid}; ${detail}`
      );
    }
  }
}
