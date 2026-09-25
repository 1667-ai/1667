import { useSyncExternalStore } from "react";
import type { ThemeMode } from "./themes.js";

const media = matchMedia("(prefers-color-scheme: dark)");

function subscribe(listener: () => void): () => void {
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}

function systemPrefersDarkNow(): boolean {
  return media.matches;
}

/**
 * Review fix C10: `theme === null` means "follow the OS"
 * (`:root { color-scheme: light dark }` in `styles/tokens.css`); this
 * resolves that to the concrete mode actually on screen, and stays current
 * if the OS scheme flips while the page is open. The toggle icon
 * (`theme/ThemeControls.tsx`) used to read `matchMedia(...).matches` once
 * during render — accurate at that instant, but never rechecked afterward,
 * so it went stale the moment the OS scheme changed under a mounted page.
 * `useSyncExternalStore` re-renders any caller when `media`'s own `change`
 * event fires instead.
 */
export function useResolvedTheme(theme: ThemeMode | null): ThemeMode {
  const systemPrefersDark = useSyncExternalStore(subscribe, systemPrefersDarkNow);
  return theme ?? (systemPrefersDark ? "dark" : "light");
}

/** For imperative code outside render (`theme/actions.ts`'s `toggleTheme`,
 * choosing which face to flip to away from "follow the OS"): a plain,
 * one-shot read of the OS preference. An event handler already runs outside
 * React's render phase, so this is never stale the way a render-time read
 * was — no subscription is needed for a single read taken at call time. */
export function systemPrefersDark(): boolean {
  return systemPrefersDarkNow();
}
