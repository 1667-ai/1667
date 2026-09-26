/** Ported from `~/source/storytavern/web/src/themes.ts` (full). The four
 *  palettes from the Storyline v2 handoff. Token values live in
 *  `styles/tokens.css`; this is the picker's metadata — ids must match the
 *  CSS `[data-palette]` blocks, dot colors mirror each palette's
 *  bg/accent/ink/line so the swatches preview the theme in the current
 *  mode. */

export type ThemeMode = "light" | "dark";

export interface PaletteSwatch {
  bg: string;
  accent: string;
  ink: string;
  line: string;
}

export interface Palette {
  id: string;
  name: string;
  tagline: string;
  dots: Record<ThemeMode, PaletteSwatch>;
}

export const PALETTES: readonly Palette[] = [
  {
    id: "ink",
    name: "Ink",
    tagline: "cool neutral · indigo",
    dots: {
      light: { bg: "#f7f8fa", accent: "#4b45c9", ink: "#191a1f", line: "#e4e6ec" },
      dark: { bg: "#131318", accent: "#9490f5", ink: "#e7e8ee", line: "#292b33" }
    }
  },
  {
    id: "typewriter",
    name: "Typewriter",
    tagline: "grayscale · ribbon red · mono",
    dots: {
      light: { bg: "#f6f5f2", accent: "#b8342c", ink: "#1d1d1a", line: "#e5e3dd" },
      dark: { bg: "#151512", accent: "#e2685e", ink: "#e9e7e0", line: "#2c2b27" }
    }
  },
  {
    id: "grove",
    name: "Grove",
    tagline: "botanical · deep green",
    dots: {
      light: { bg: "#f3f6f2", accent: "#2e7d52", ink: "#182018", line: "#dfe7dc" },
      dark: { bg: "#0f130e", accent: "#7cc492", ink: "#e3e9e1", line: "#252c22" }
    }
  },
  {
    id: "nocturne",
    name: "Nocturne",
    tagline: "blue-black · gilt",
    dots: {
      light: { bg: "#f4f5f9", accent: "#8a621d", ink: "#171a24", line: "#e1e4ee" },
      dark: { bg: "#0d0f16", accent: "#d5a44a", ink: "#e5e8f2", line: "#232839" }
    }
  }
] as const;

export const DEFAULT_PALETTE = "ink";
