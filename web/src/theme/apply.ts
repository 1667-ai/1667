import { DEFAULT_PALETTE, type ThemeMode } from "./themes.js";

/** localStorage keys. Per-browser-profile only, and lost across a fresh
 * `1667 web` port on purpose (owner decision) — nothing here persists a
 * value anywhere the server can see. */
const THEME_KEY = "1667.web.theme";
const PALETTE_KEY = "1667.web.palette";

/** `null` means "no explicit override" — the page follows the OS light/dark
 * setting through `:root { color-scheme: light dark }` and `light-dark()`
 * tokens (`styles/tokens.css`), with no theme script needed before paint. */
export function readStoredTheme(): ThemeMode | null {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

export function readStoredPalette(): string {
  try {
    return localStorage.getItem(PALETTE_KEY) ?? DEFAULT_PALETTE;
  } catch {
    return DEFAULT_PALETTE;
  }
}

/** Sets `[data-theme]` on the root element, or clears it for "follow the
 * OS". `main.tsx` calls this once before `createRoot`, in a `try`, so the
 * very first paint already carries the right override — no flash. */
export function applyTheme(theme: ThemeMode | null): void {
  const root = document.documentElement;
  if (theme === null) root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

export function applyPalette(palette: string): void {
  document.documentElement.setAttribute("data-palette", palette);
}

export function persistTheme(theme: ThemeMode | null): void {
  try {
    if (theme === null) localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Private browsing, or storage disabled: the override lasts this tab only.
  }
}

export function persistPalette(palette: string): void {
  try {
    localStorage.setItem(PALETTE_KEY, palette);
  } catch {
    // Same as `persistTheme`.
  }
}
