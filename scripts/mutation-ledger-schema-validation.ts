import Ajv2020 from "ajv/dist/2020.js";
import type { MutationLedgerCorpusCase } from "./mutation-ledger-schema-corpus.js";

/** Structural schema verdicts are pinned separately from canonical-byte, NFC,
 * calendar, size, and cross-field runtime rules. */
export function assertMutationLedgerSchemaCorpus(
  schema: Record<string, unknown>,
  cases: readonly MutationLedgerCorpusCase[]
): void {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  if (!ajv.validateSchema(schema)) {
    throw new Error(`Mutation ledger JSON Schema is invalid: ${ajv.errorsText(ajv.errors)}`);
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
        `Mutation ledger schema corpus mismatch for ${fixture.name}: `
        + `expected schemaValid=${fixture.schemaValid}; ${detail}`
      );
    }
  }
}
