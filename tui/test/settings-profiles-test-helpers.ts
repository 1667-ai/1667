import {
  applyBasicSettingsDraft,
  basicSettingsFromDocument
} from "../../shared/settings-basic-draft.js";
import { selectSettingsRoute } from "../../shared/settings-route.js";
import type {
  SettingsView
} from "../../shared/settings-v2-types.js";
import type { SettingsDocumentV5 as SettingsDocumentV2 } from "../../shared/settings-v5-types.js";
import { settingsTextDraftForDocument } from "../src/settings-text.js";
import type { settingsHarness } from "./settings-test-harness.js";

type EditableSettingsView = Extract<SettingsView, { readonly dataFormat: 2 }>;

export function installNetworkSettings(
  source: ReturnType<typeof settingsHarness>["source"],
  storedSecretId?: string
): EditableSettingsView {
  if (!source.settingsView.editable) throw new Error("demo settings must be editable");
  let document = applyBasicSettingsDraft(source.settingsView.document, {
    ...source.settings,
    provider: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5.6",
    apiKeyEnv: null
  });
  const route = selectSettingsRoute(document, "default");
  document = {
    ...document,
    connections: {
      ...document.connections,
      [route.model.connectionId]: {
        ...route.connection,
        auth: storedSecretId === undefined
          ? { type: "none" }
          : { type: "bearer-stored", secretId: storedSecretId }
      }
    },
    models: {
      ...document.models,
      [route.profile.modelId]: {
        ...route.model,
        capabilities: { ...route.model.capabilities, reasoningEffort: "supported" }
      }
    }
  };
  const effective = basicSettingsFromDocument(document);
  const view: EditableSettingsView = {
    ...source.settingsView,
    document,
    effective,
    effectiveProse: effective
  };
  source.settings = effective;
  source.settingsView = view;
  source.api.getSettings = async () => source.settingsView;
  return view;
}

export function declareSelectedModelSupportsEffort(
  state: ReturnType<typeof settingsHarness>["state"]
): void {
  const overlay = state.settings;
  const document = overlay?.draft.document;
  const profileId = overlay?.draft.selectedProfileId;
  if (overlay === null || overlay === undefined
    || document === null || document === undefined
    || profileId === null || profileId === undefined) {
    throw new Error("selected profile missing");
  }
  const modelId = document.profiles[profileId]!.modelId;
  overlay.draft = settingsTextDraftForDocument({
    ...document,
    models: {
      ...document.models,
      [modelId]: {
        ...document.models[modelId]!,
        capabilities: {
          ...document.models[modelId]!.capabilities,
          reasoningEffort: "supported"
        }
      }
    }
  }, profileId);
}

export function declareSelectedModelReturnsReasoning(
  state: ReturnType<typeof settingsHarness>["state"],
  reasoningContent: "supported" | "unsupported" = "supported"
): void {
  const overlay = state.settings;
  const document = overlay?.draft.document;
  const profileId = overlay?.draft.selectedProfileId;
  if (overlay === null || overlay === undefined
    || document === null || document === undefined
    || profileId === null || profileId === undefined) {
    throw new Error("selected profile missing");
  }
  const modelId = document.profiles[profileId]!.modelId;
  overlay.draft = settingsTextDraftForDocument({
    ...document,
    models: {
      ...document.models,
      [modelId]: {
        ...document.models[modelId]!,
        capabilities: {
          ...document.models[modelId]!.capabilities,
          reasoningContent
        }
      }
    }
  }, profileId);
}

export function savedView(
  view: EditableSettingsView,
  document: SettingsDocumentV2
): EditableSettingsView {
  const effective = basicSettingsFromDocument(document);
  return {
    ...view,
    stateGeneration: view.stateGeneration + 1,
    activeRevision: view.activeRevision + 1,
    document,
    effective,
    effectiveProse: basicSettingsFromDocument(
      document,
      selectSettingsRoute(document, "prose").profileId
    )
  };
}

export function savedResult(view: EditableSettingsView) {
  return {
    kind: "settings" as const,
    settingsStateGeneration: view.stateGeneration,
    activeSettingsRevision: view.activeRevision,
    pendingSettingsRevision: null,
    activationOutcome: null
  };
}
