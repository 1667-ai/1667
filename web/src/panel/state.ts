/**
 * The story's right-hand panel (#409 step 7a): one panel with three views,
 * Chapters, Facts and (step 10h) the Fact check's Findings. `view` is `null`
 * while it is closed. `factsDocked` keeps the Facts view open beside the
 * manuscript without taking the keyboard (`F`); it is remembered across visits.
 */
export type PanelView = "chapters" | "facts" | "findings";

export interface PanelState {
  readonly view: PanelView | null;
  readonly factsDocked: boolean;
  /** Raised by every request to open a view, so the panel takes the keyboard
   * even when that view is already showing. */
  readonly openSerial: number;
}

const DOCKED_KEY = "1667.web.factsDocked";

export function readStoredFactsDocked(): boolean {
  try {
    return localStorage.getItem(DOCKED_KEY) === "1";
  } catch {
    return false;
  }
}

export function storeFactsDocked(docked: boolean): void {
  try {
    localStorage.setItem(DOCKED_KEY, docked ? "1" : "0");
  } catch {
    // Storage can be blocked; the dock then lasts for this visit only.
  }
}

export function initialPanelState(): PanelState {
  return { view: null, factsDocked: readStoredFactsDocked(), openSerial: 0 };
}
