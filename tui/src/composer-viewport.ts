/** The default inline editor height from design section 11. */
export function composerHeightCap(
  terminalHeight: number,
  override?: number | null
): number {
  if (override !== null && override !== undefined
    && Number.isFinite(override) && override >= 1) {
    return Math.floor(override);
  }
  return Math.max(6, Math.floor(Math.max(0, terminalHeight) / 3));
}

/** Number of editable rows in a composer with the standard one-row footer. */
export function composerPageRows(
  terminalHeight: number,
  fullscreen: boolean,
  override?: number | null
): number {
  const height = Math.max(4, Math.floor(terminalHeight));
  return fullscreen
    ? Math.max(1, height - 3)
    : Math.max(1, Math.min(composerHeightCap(height, override), height - 4));
}
