import type { SettingsDocumentV4, SettingsStateV4 } from "../shared/settings-v4-types.js";
import {
  hashSettingsDocumentV4,
  parseSettingsDocumentV4,
  parseSettingsStateV4
} from "./settings-v4-codec.js";
import {
  isExactSettingsActivationSuccessorFor,
  recoverSettingsState,
  recoveryEventForSettingsState,
  reduceSettingsState,
  type SettingsStateEvent,
  type SettingsStateReducerSchema
} from "./settings-state-reducer.js";

export type SettingsStateV4Event = SettingsStateEvent<SettingsDocumentV4>;

const SCHEMA: SettingsStateReducerSchema<4, SettingsDocumentV4> = {
  parseState: parseSettingsStateV4,
  parseDocument: parseSettingsDocumentV4,
  hashDocument: hashSettingsDocumentV4
};

export function reduceSettingsStateV4(
  input: SettingsStateV4,
  event: SettingsStateV4Event
): SettingsStateV4 {
  return reduceSettingsState(SCHEMA, input, event);
}

export function recoveryEventForSettingsStateV4(state: SettingsStateV4): SettingsStateV4Event | null {
  return recoveryEventForSettingsState(state);
}

export function recoverSettingsStateV4(input: SettingsStateV4): SettingsStateV4 {
  return recoverSettingsState(SCHEMA, input);
}

export function isExactSettingsActivationSuccessorV4(
  input: SettingsStateV4,
  candidate: SettingsStateV4
): boolean {
  return isExactSettingsActivationSuccessorFor(SCHEMA, input, candidate);
}
