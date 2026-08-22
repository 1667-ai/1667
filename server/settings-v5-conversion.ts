import type {
  ModelDefinitionV3,
  SettingsActivationV2,
  SettingsDocumentV2,
  SettingsDocumentV3,
  SettingsStateEnvelope,
  SettingsStateV2,
  SettingsStateV3
} from "../shared/settings-v2-types.js";
import type {
  GenerationProfileV4,
  SettingsDocumentV4,
  SettingsStateV4
} from "../shared/settings-v4-types.js";
import type {
  GenerationProfileV5,
  ModelDefinitionV5,
  SettingsDocumentV5,
  SettingsStateV5
} from "../shared/settings-v5-types.js";
import type { GenerationProfileV2 } from "../shared/settings-v2-types.js";
import {
  independentGenerationReasoningV5,
  legacyGenerationReasoningV5
} from "../shared/settings-v5-reasoning.js";
import { writingPromptSettingsFromAuthorBrief } from "../shared/settings-v5-writing.js";
import { hashCanonicalSettingsDocument } from "./settings-v2-hash.js";
import { hashSettingsDocumentV5, parseSettingsDocumentV5, parseSettingsStateV5 } from "./settings-v5-codec.js";

export function convertSettingsDocumentV2ToV5(document: SettingsDocumentV2): SettingsDocumentV5 {
  return parseSettingsDocumentV5({
    schemaVersion: 5,
    connections: document.connections,
    models: convertModelsFromV2(document),
    profiles: convertLegacyProfiles(document.profiles),
    routing: document.routing,
    writing: writingPromptSettingsFromAuthorBrief(document.writing.defaultAuthorBrief)
  });
}

export function convertSettingsDocumentV3ToV5(document: SettingsDocumentV3): SettingsDocumentV5 {
  return parseSettingsDocumentV5({
    schemaVersion: 5,
    connections: document.connections,
    models: document.models,
    profiles: convertLegacyProfiles(document.profiles),
    routing: document.routing,
    writing: writingPromptSettingsFromAuthorBrief(document.writing.defaultAuthorBrief)
  });
}

export function convertSettingsDocumentV4ToV5(document: SettingsDocumentV4): SettingsDocumentV5 {
  return parseSettingsDocumentV5({
    schemaVersion: 5,
    connections: document.connections,
    models: document.models,
    profiles: convertIndependentProfiles(document.profiles),
    routing: document.routing,
    writing: writingPromptSettingsFromAuthorBrief(document.writing.defaultAuthorBrief)
  });
}

export function convertSettingsStateV2ToV5(state: SettingsStateV2): SettingsStateV5 {
  return convertSettingsStateToV5(state, convertSettingsDocumentV2ToV5);
}

export function convertSettingsStateV3ToV5(state: SettingsStateV3): SettingsStateV5 {
  return convertSettingsStateToV5(state, convertSettingsDocumentV3ToV5);
}

export function convertSettingsStateV4ToV5(state: SettingsStateV4): SettingsStateV5 {
  return convertSettingsStateToV5(state, convertSettingsDocumentV4ToV5);
}

function convertSettingsStateToV5<V extends 2 | 3 | 4, D extends SettingsDocumentV2 | SettingsDocumentV3 | SettingsDocumentV4>(
  state: SettingsStateEnvelope<V, D>,
  convertDocument: (document: D) => SettingsDocumentV5
): SettingsStateV5 {
  const documents: Record<string, SettingsDocumentV5> = {};
  for (const [revision, document] of Object.entries(state.documents)) {
    documents[revision] = convertDocument(document);
  }
  const converted = {
    schemaVersion: 5 as const,
    stateGeneration: state.stateGeneration,
    settingsRevisionClock: state.settingsRevisionClock,
    documents,
    activeRevision: state.activeRevision,
    pendingRevision: state.pendingRevision,
    previousRevision: state.previousRevision,
    activation: rebindActivation(state, documents),
    lastActivationOutcome: state.lastActivationOutcome,
    lastTransaction: state.lastTransaction
  };
  // Converted initial schema-2/3/4 states keep a null pointer, but their
  // documents are not the canonical schema-5 initial vector. Parse only
  // after a save binds a mutation pointer.
  if (converted.lastTransaction === null) {
    return converted as SettingsStateV5;
  }
  return parseSettingsStateV5(converted);
}

function rebindActivation<V extends 2 | 3 | 4, D extends SettingsDocumentV2 | SettingsDocumentV3 | SettingsDocumentV4>(
  state: SettingsStateEnvelope<V, D>,
  documentsV5: Readonly<Record<string, SettingsDocumentV5>>
): SettingsActivationV2 | null {
  if (state.activation === null) return null;
  const activation = state.activation;
  return {
    ...activation,
    oldHash: hashSettingsDocumentV5(
      documentAtSourceHash(state, documentsV5, activation.oldHash, "oldHash")
    ),
    candidateHash: hashSettingsDocumentV5(
      documentAtSourceHash(state, documentsV5, activation.candidateHash, "candidateHash")
    )
  };
}

function documentAtSourceHash<V extends 2 | 3 | 4, D extends SettingsDocumentV2 | SettingsDocumentV3 | SettingsDocumentV4>(
  state: SettingsStateEnvelope<V, D>,
  documentsV5: Readonly<Record<string, SettingsDocumentV5>>,
  hash: string,
  field: "oldHash" | "candidateHash"
): SettingsDocumentV5 {
  const revision = Object.entries(state.documents).find(
    ([, document]) => hashCanonicalSettingsDocument(document) === hash
  )?.[0];
  if (revision === undefined) {
    throw new Error(`settings activation ${field} does not bind any document in this state`);
  }
  return documentsV5[revision]!;
}

function convertModelsFromV2(document: SettingsDocumentV2): Record<string, ModelDefinitionV5> {
  const models: Record<string, ModelDefinitionV3> = {};
  for (const [id, model] of Object.entries(document.models)) {
    const isDryRun = document.connections[model.connectionId]?.protocol === "dry-run";
    models[id] = {
      ...model,
      capabilities: {
        ...model.capabilities,
        imageInput: isDryRun ? "unsupported" : "unknown"
      }
    };
  }
  return models;
}

function convertLegacyProfiles(
  profiles: Readonly<Record<string, GenerationProfileV2>>
): Record<string, GenerationProfileV5> {
  const result: Record<string, GenerationProfileV5> = {};
  for (const [id, profile] of Object.entries(profiles)) {
    const { effort, ...rest } = profile;
    result[id] = {
      ...rest,
      generationReasoning: legacyGenerationReasoningV5(effort)
    };
  }
  return result;
}

function convertIndependentProfiles(
  profiles: Readonly<Record<string, GenerationProfileV4>>
): Record<string, GenerationProfileV5> {
  const result: Record<string, GenerationProfileV5> = {};
  for (const [id, profile] of Object.entries(profiles)) {
    const { effort, thinkingMode, ...rest } = profile;
    result[id] = {
      ...rest,
      generationReasoning: independentGenerationReasoningV5(effort, thinkingMode)
    };
  }
  return result;
}
