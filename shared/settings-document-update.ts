import type { GenerationEffortV2 } from "./settings-v2-types.js";
import type { GenerationEffortV4 } from "./settings-v4-types.js";
import type {
  GenerationProfileV5,
  SettingsDocumentV5
} from "./settings-v5-types.js";
import type { WritingPromptFieldId, WritingPromptSettings } from "./settings-v5-writing.js";

/** Patch for one schema-5 document. Omitted `writing` keeps the source object. */
export type SettingsDocumentV5Patch = {
  readonly connections?: SettingsDocumentV5["connections"];
  readonly models?: SettingsDocumentV5["models"];
  readonly profiles?: SettingsDocumentV5["profiles"];
  readonly routing?: SettingsDocumentV5["routing"];
  readonly writing?: WritingPromptSettings;
};

/** Apply one document mutation and keep the complete writing object unless the
 *  mutation itself supplies a writing value. */
export function updateSettingsDocumentV5(
  document: SettingsDocumentV5,
  patch: SettingsDocumentV5Patch
): SettingsDocumentV5 {
  return {
    schemaVersion: 5,
    connections: patch.connections ?? document.connections,
    models: patch.models ?? document.models,
    profiles: patch.profiles ?? document.profiles,
    routing: patch.routing ?? document.routing,
    writing: patch.writing ?? document.writing
  };
}

/** Replace one writing field and keep every other writing field. */
export function updateSettingsWritingField(
  document: SettingsDocumentV5,
  field: WritingPromptFieldId,
  value: string
): SettingsDocumentV5 {
  return updateSettingsDocumentV5(document, {
    writing: { ...document.writing, [field]: value }
  });
}

export function settingsProfileEffort(
  profile: GenerationProfileV5
): GenerationEffortV2 | GenerationEffortV4 {
  return profile.generationReasoning.effort;
}

export function withSettingsProfileEffort(
  profile: GenerationProfileV5,
  effort: GenerationEffortV2 | GenerationEffortV4
): GenerationProfileV5 {
  const reasoning = profile.generationReasoning;
  if (reasoning.kind === "legacy") {
    return {
      ...profile,
      generationReasoning: { kind: "legacy", effort: effort as GenerationEffortV2 }
    };
  }
  return {
    ...profile,
    generationReasoning: {
      kind: "independent",
      effort: effort as GenerationEffortV4,
      thinkingMode: reasoning.thinkingMode
    }
  };
}
