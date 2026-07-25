import Ajv2020 from "ajv/dist/2020.js";
import type { StoryManifestCorpusCase } from "./story-schema-corpus.js";

/** Validate the generated schema itself, then prove its structural verdict for
 * every corpus entry. Runtime-only byte/canonical/semantic rules stay separate. */
export function assertStorySchemaCorpus(
  schema: Record<string, unknown>,
  cases: readonly StoryManifestCorpusCase[]
): void {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  if (!ajv.validateSchema(schema)) {
    throw new Error(`Story manifest JSON Schema is invalid: ${ajv.errorsText(ajv.errors)}`);
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
        `Story schema corpus mismatch for ${fixture.name}: expected schemaValid=${fixture.schemaValid}; ${detail}`
      );
    }
  }
}
