/** "Show directions" is a reading preference, not a story field — the same
 * per-browser-profile, per-run-loss-accepted localStorage treatment as
 * `theme/apply.ts`'s theme/palette (owner decision). */
const SHOW_DIRECTIONS_KEY = "1667.web.directions";

export function readStoredShowDirections(): boolean {
  try {
    return localStorage.getItem(SHOW_DIRECTIONS_KEY) === "1";
  } catch {
    return false;
  }
}

export function persistShowDirections(showDirections: boolean): void {
  try {
    localStorage.setItem(SHOW_DIRECTIONS_KEY, showDirections ? "1" : "0");
  } catch {
    // Private browsing, or storage disabled: the setting lasts this tab only.
  }
}
