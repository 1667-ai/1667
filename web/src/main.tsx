import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { createApp } from "./app/bootstrap.js";
import { applyPalette, applyTheme, readStoredPalette, readStoredTheme } from "./theme/apply.js";
import { DEFAULT_PALETTE, type ThemeMode } from "./theme/themes.js";
import "./styles/index.css";

/**
 * Applies the stored theme/palette override to `<html>` before `createRoot`,
 * so the very first paint already carries it — no pre-paint script, which
 * the CSP (`host/web-server.ts`) forbids anyway (`script-src 'self'`, no
 * `'unsafe-inline'`). `:root { color-scheme: light dark }` in
 * `styles/tokens.css` already covers "no override yet" by following the OS.
 */
let theme: ThemeMode | null = null;
let palette: string = DEFAULT_PALETTE;
try {
  theme = readStoredTheme();
  palette = readStoredPalette();
  applyTheme(theme);
  applyPalette(palette);
} catch {
  // A hostile or unusual DOM/storage must not stop the app from rendering;
  // it starts with no explicit override instead.
}

// Built once, outside React (review fix A1): `App.tsx` only starts it (in an
// effect whose cleanup calls the disposer `start()` returns) and provides it
// to the component tree — it never rebuilds the store or the connection
// itself.
const app = createApp(theme, palette);

const container = document.getElementById("app");
if (container === null) throw new Error("1667 web: index.html has no #app element");

createRoot(container).render(
  <StrictMode>
    <App app={app} />
  </StrictMode>
);
