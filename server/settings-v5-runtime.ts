import {
  SETTINGS_ROUTE_PURPOSE_VALUES,
  type SettingsView
} from "../shared/settings-v2-types.js";
import type { SettingsDocumentV5, SettingsStateV5 } from "../shared/settings-v5-types.js";
import { continuationPromptLayoutForOptimization } from "../shared/continuation-prompt-optimization.js";
import { convertSettingsDocumentV2ToV5 } from "./settings-v5-conversion.js";
import { convertSettingsStateSlotToV5 } from "./settings-state-authority.js";
import { shownSettingsDocumentV5, activeWritingFromSlot } from "./settings-working-document.js";
import type { SettingsRuntimeResolver } from "./settings-runtime-resolver.js";
import {
  effectiveSettingsStateRevision,
  settingsStateRelation
} from "./settings-state-validation.js";
import { invalidSettingsMutation } from "./settings-v2-mutation.js";
import type { SettingsStateSlot } from "./settings-state-slot.js";

export function settingsViewFromStateV5(
  state: SettingsStateV5,
  runtimeResolver: SettingsRuntimeResolver
): Extract<SettingsView, { dataFormat: 2 }> {
  const pendingRevision = settingsStateRelation(state) === "committed"
    ? null
    : state.pendingRevision;
  const shown = shownSettingsDocumentV5(state);
  const activeRevision = effectiveSettingsStateRevision(state);
  const active = state.documents[String(activeRevision)]!;
  const effective = runtimeResolver.resolveV5({ document: active, purpose: "default" });
  const effectiveProse = runtimeResolver.resolveV5({ document: active, purpose: "prose" });
  return {
    dataFormat: 2,
    editable: true,
    stateGeneration: state.stateGeneration,
    activeRevision,
    pendingRevision,
    document: shown,
    effective: effective.settings,
    effectiveProse: effectiveProse.settings,
    effectiveProseReasoning: effectiveProse.route.reasoning,
    effectiveProseContinuationPromptLayout: continuationPromptLayoutForOptimization(
      effectiveProse.route.continuationPromptOptimization
    ),
    activeWriting: active.writing,
    lastActivationOutcome: state.lastActivationOutcome
  };
}

export function settingsViewFromSlot(
  slot: SettingsStateSlot,
  runtimeResolver: SettingsRuntimeResolver
): Extract<SettingsView, { dataFormat: 2 }> {
  const state = convertSettingsStateSlotToV5(slot);
  const view = settingsViewFromStateV5(state, runtimeResolver);
  return {
    ...view,
    activeWriting: activeWritingFromSlot(slot)
  };
}

export function assertRuntimeDocumentSupportedV5(
  document: SettingsDocumentV5,
  runtimeResolver: SettingsRuntimeResolver
): void {
  try {
    for (const purpose of SETTINGS_ROUTE_PURPOSE_VALUES) {
      runtimeResolver.resolveV5({ document, purpose });
    }
  } catch (error) {
    throw invalidSettingsMutation(error);
  }
}

export function workingDocumentFromV2Shown(
  document: Parameters<typeof convertSettingsDocumentV2ToV5>[0]
): SettingsDocumentV5 {
  return convertSettingsDocumentV2ToV5(document);
}
