import type {
  SettingsDocumentV2,
  SettingsStateV2
} from "../shared/settings-v2-types.js";
import {
  hashSettingsDocumentV2,
  parseSettingsDocumentV2,
  parseSettingsStateV2
} from "./settings-v2-codec.js";
import {
  isExactSettingsActivationSuccessorFor,
  recoverSettingsState,
  recoveryEventForSettingsState,
  reduceSettingsState,
  SETTINGS_SAVE_ADMISSIBLE_RELATIONS,
  settingsDocumentsChangeCredentialReferences,
  settingsStateRelation,
  type SettingsStateEvent,
  type SettingsStateReducerSchema
} from "./settings-state-reducer.js";

export type SettingsStateV2Event = SettingsStateEvent<SettingsDocumentV2>;

export {
  SETTINGS_SAVE_ADMISSIBLE_RELATIONS,
  settingsDocumentsChangeCredentialReferences,
  settingsStateRelation
};

const SCHEMA: SettingsStateReducerSchema<2, SettingsDocumentV2> = {
  parseState: parseSettingsStateV2,
  parseDocument: parseSettingsDocumentV2,
  hashDocument: hashSettingsDocumentV2
};

export function reduceSettingsStateV2(
  input: SettingsStateV2,
  event: SettingsStateV2Event
): SettingsStateV2 {
  return reduceSettingsState(SCHEMA, input, event);
}

export function recoveryEventForSettingsStateV2(state: SettingsStateV2): SettingsStateV2Event | null {
  return recoveryEventForSettingsState(state);
}

export function recoverSettingsStateV2(input: SettingsStateV2): SettingsStateV2 {
  return recoverSettingsState(SCHEMA, input);
}

export function isExactSettingsActivationSuccessor(
  input: SettingsStateV2,
  candidate: SettingsStateV2
): boolean {
  return isExactSettingsActivationSuccessorFor(SCHEMA, input, candidate);
}
