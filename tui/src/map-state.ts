export { MAP_VIEWS, type MapView } from "../../shared/map-model.js";
import { MAP_VIEWS, type MapMassSort, type MapView } from "../../shared/map-model.js";

export { MAP_MASS_SORTS, nextMassSort, type MapMassSort } from "../../shared/map-model.js";

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

