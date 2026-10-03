/**
 * The story's right-hand panel (#409 step 7a): one panel with room for more
 * than one view (Facts joins Chapters later). `view` is `null` while it is
 * closed.
 */
export type PanelView = "chapters";

export interface PanelState {
  readonly view: PanelView | null;
}

export function initialPanelState(): PanelState {
  return { view: null };
}
