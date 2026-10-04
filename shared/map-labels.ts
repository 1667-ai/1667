/** First six words of a preview, for a sketch's quoted opening. Shared by the
 * lane tree and the mass graph: a display concern, not a layout one. */
export function opening(value: string): string {
  return value.replace(/\s+/g, " ").trim().split(" ").slice(0, 6).join(" ");
}
