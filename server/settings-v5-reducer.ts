import type { SettingsDocumentV5, SettingsStateV5 } from "../shared/settings-v5-types.js";
import {
  hashSettingsDocumentV5,
  parseSettingsDocumentV5,
  parseSettingsStateV5
} from "./settings-v5-codec.js";
import {
  isExactSettingsActivationSuccessorFor,
  recoverSettingsState,
  recoveryEventForSettingsState,
  reduceSettingsState,
  SETTINGS_SAVE_ADMISSIBLE_RELATIONS,
  type SettingsStateEvent,
  type SettingsStateReducerSchema
} from "./settings-state-reducer.js";

export type SettingsStateV5Event = SettingsStateEvent<SettingsDocumentV5>;

export { SETTINGS_SAVE_ADMISSIBLE_RELATIONS };

const SCHEMA: SettingsStateReducerSchema<5, SettingsDocumentV5> = {
  parseState: parseSettingsStateV5,
  parseDocument: parseSettingsDocumentV5,
  hashDocument: hashSettingsDocumentV5
};

export function reduceSettingsStateV5(
  input: SettingsStateV5,
  event: SettingsStateV5Event
): SettingsStateV5 {
  return reduceSettingsState(SCHEMA, input, event);
}

export function recoveryEventForSettingsStateV5(state: SettingsStateV5): SettingsStateV5Event | null {
  return recoveryEventForSettingsState(state);
}

export function recoverSettingsStateV5(input: SettingsStateV5): SettingsStateV5 {
  return recoverSettingsState(SCHEMA, input);
}

export function isExactSettingsActivationSuccessorV5(
  input: SettingsStateV5,
  candidate: SettingsStateV5
): boolean {
  return isExactSettingsActivationSuccessorFor(SCHEMA, input, candidate);
}
