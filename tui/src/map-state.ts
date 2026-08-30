export const MAP_VIEWS = ["path", "tree", "mass"] as const;
export type MapView = (typeof MAP_VIEWS)[number];

export const MAP_MASS_SORTS = ["size", "recency", "depth", "name"] as const;
export type MapMassSort = (typeof MAP_MASS_SORTS)[number];

/** Interaction state shared by the three full-bleed views of one story map. */
export interface MapState {
  view: MapView;
  pathCursorId: string;
  /** PATH submode: include childless sibling takes instead of only branches. */
  pathShowAllTakes: boolean;
  treeCursorId: string | null;
  rowIds: string[];
  showSketches: boolean;
  openedColdFolds: Set<string>;
  massSort: MapMassSort;
  /** Fact lens selection; transient and only meaningful in the tree view. */
  factLensFactId?: string | null;
}

export function nextMapView(view: MapView): MapView {
  return MAP_VIEWS[(MAP_VIEWS.indexOf(view) + 1) % MAP_VIEWS.length]!;
}

export function nextMassSort(sort: MapMassSort): MapMassSort {
  return MAP_MASS_SORTS[(MAP_MASS_SORTS.indexOf(sort) + 1) % MAP_MASS_SORTS.length]!;
}
