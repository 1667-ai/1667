import { graphemeCells } from "./cell-width.js";

/** Find the two visible arrow cells in a painted `‹ value ›` choice.
 * Settings uses this geometry for the same controls that story choice rows
 * own directly. */
export function choiceArrowColumns(
  drawn: string,
  valueLeft: number
): { readonly previous: number; readonly next: number } | null {
  const cells = graphemeCells(drawn);
  const opening = cells[0]?.text;
  if (opening !== "‹" && opening !== "[") return null;
  let column = 0;
  for (const cell of cells) {
    if (column > 0 && (cell.text === "›" || cell.text === "]")) {
      return { previous: valueLeft, next: valueLeft + column };
    }
    column += cell.width;
  }
  return null;
}
