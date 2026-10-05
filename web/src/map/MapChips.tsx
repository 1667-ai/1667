import type { FactLensNode } from "../../../shared/map-fact-lens.js";

/** Marks the take being written: the pending take, or the leaf an append grows. */
export function WritingChip() {
  return <span className="map-chip map-chip-writing">Writing…</span>;
}

/** What the open Fact lens says about a row, in words: an anchored state, or
 * the end of the Fact. */
export function LensChip({ lens }: { readonly lens: FactLensNode }) {
  if (lens.end) return <span className="map-chip map-chip-lens" title="The Fact ends here">Fact ends</span>;
  if (lens.anchor) {
    const label = lens.stateIndex === null ? "Fact state" : `Fact state ${lens.stateIndex + 1}`;
    return <span className="map-chip map-chip-lens" title="A state of the Fact starts here">{label}</span>;
  }
  return null;
}
