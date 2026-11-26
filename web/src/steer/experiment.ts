import type { AppState } from "../app/state.js";
import type { Store } from "../app/store.js";

/** The steer page is experimental (#462). It stays hidden until the reader
 * turns it on under Settings › Experimental. The switch is a browser
 * preference, like the theme: kept in this browser profile, and lost without
 * complaint when storage is not available. */
const STEER_KEY = "1667.web.experiment.steer";

export const STEER_OFF_TEXT = "The steer page is experimental. Turn it on in Settings, under Experimental.";

export function readStoredSteerEnabled(): boolean {
  try {
    return localStorage.getItem(STEER_KEY) === "1";
  } catch {
    return false;
  }
}

function persistSteerEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(STEER_KEY, enabled ? "1" : "0");
  } catch {
    // Private browsing, or storage disabled: the switch lasts this tab only.
  }
}

export interface ExperimentActions {
  setSteer(enabled: boolean): void;
}

export function createExperimentActions(store: Store<AppState>): ExperimentActions {
  return {
    setSteer: (enabled) => {
      persistSteerEnabled(enabled);
      store.set((state) => ({ ...state, experiments: { ...state.experiments, steer: enabled } }));
    }
  };
}
