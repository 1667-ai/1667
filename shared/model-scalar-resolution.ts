import type {
  ModelDefinitionV2,
  ModelScalarMetadataV2
} from "./settings-v2-types.js";

export interface ModelScalarMetadataSourcesV2 {
  readonly runtime?: ModelScalarMetadataV2;
  readonly builtin?: ModelScalarMetadataV2;
}

/** Resolve one model scalar with the same precedence in every projection. */
export function resolveModelScalar(
  model: ModelDefinitionV2,
  metadata: ModelScalarMetadataSourcesV2,
  scalar: keyof ModelScalarMetadataV2
): number | undefined {
  return model.overrides[scalar]
    ?? metadata.runtime?.[scalar]
    ?? model.discovered[scalar]
    ?? metadata.builtin?.[scalar];
}

/** Cap a profile output request when the selected model has a known limit. */
export function clampMaxOutputTokensToModel(
  requested: number,
  model: ModelDefinitionV2,
  metadata: ModelScalarMetadataSourcesV2 = {}
): number {
  const maximum = resolveModelScalar(model, metadata, "maxOutputTokens");
  return maximum === undefined ? requested : Math.min(requested, maximum);
}
