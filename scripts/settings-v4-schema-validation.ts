import Ajv2020 from "ajv/dist/2020.js";
import type { SettingsV4CorpusCase } from "./settings-v4-schema-corpus.js";

/** Validate structural schema verdicts for the checked-in V4 corpus. */
export function assertSettingsV4SchemaCorpus(
  schema: Record<string, unknown>,
  cases: readonly SettingsV4CorpusCase[]
): void {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  if (!ajv.validateSchema(schema)) {
    throw new Error(`Settings v4 JSON Schema is invalid: ${ajv.errorsText(ajv.errors)}`);
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
        `Settings v4 schema corpus mismatch for ${fixture.name}: `
        + `expected schemaValid=${fixture.schemaValid}; ${detail}`
      );
    }
  }
}
