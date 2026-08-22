import type { SettingsDocumentV3, SettingsStateV3 } from "../shared/settings-v2-types.js";
import {
  hashSettingsDocumentV3,
  parseSettingsDocumentV3,
  parseSettingsStateV3
} from "./settings-v3-codec.js";
import {
  isExactSettingsActivationSuccessorFor,
  recoverSettingsState,
  recoveryEventForSettingsState,
  reduceSettingsState,
  type SettingsStateEvent,
  type SettingsStateReducerSchema
} from "./settings-state-reducer.js";

export type SettingsStateV3Event = SettingsStateEvent<SettingsDocumentV3>;

const SCHEMA: SettingsStateReducerSchema<3, SettingsDocumentV3> = {
  parseState: parseSettingsStateV3,
  parseDocument: parseSettingsDocumentV3,
  hashDocument: hashSettingsDocumentV3
};

export function reduceSettingsStateV3(
  input: SettingsStateV3,
  event: SettingsStateV3Event
): SettingsStateV3 {
  return reduceSettingsState(SCHEMA, input, event);
}

export function recoveryEventForSettingsStateV3(state: SettingsStateV3): SettingsStateV3Event | null {
  return recoveryEventForSettingsState(state);
}

export function recoverSettingsStateV3(input: SettingsStateV3): SettingsStateV3 {
  return recoverSettingsState(SCHEMA, input);
}

export function isExactSettingsActivationSuccessorV3(
  input: SettingsStateV3,
  candidate: SettingsStateV3
): boolean {
  return isExactSettingsActivationSuccessorFor(SCHEMA, input, candidate);
}
