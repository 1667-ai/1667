/** Typewriter mode (`z`) is a reading preference like "Show directions":
 * remembered per browser profile, and lost without complaint when storage is
 * not available. */
const TYPEWRITER_KEY = "1667.web.typewriter";

export function readStoredTypewriter(): boolean {
  try {
    return localStorage.getItem(TYPEWRITER_KEY) === "1";
  } catch {
    return false;
  }
}

export function persistTypewriter(typewriter: boolean): void {
  try {
    localStorage.setItem(TYPEWRITER_KEY, typewriter ? "1" : "0");
  } catch {
    // Private browsing, or storage disabled: the mode lasts this tab only.
  }
}
