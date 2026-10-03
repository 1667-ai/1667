/**
 * The story's right-hand panel (#409 step 7a): one panel with two views,
 * Chapters and Facts. `view` is `null` while it is closed. `factsDocked` keeps
 * the Facts view open beside the manuscript without taking the keyboard (`F`);
 * it is remembered across visits.
 */
export type PanelView = "chapters" | "facts";

export interface PanelState {
  readonly view: PanelView | null;
  readonly factsDocked: boolean;
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
  return { view: null, factsDocked: readStoredFactsDocked() };
}
