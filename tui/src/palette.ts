import { RGBA, type ColorInput } from "@opentui/core";
import type { ThemeName } from "./config.js";

export type PaletteRole =
  | "background" | "raised" | "chrome" | "prose" | "prose · dim"
  | "focus / accent" | "accent · deep" | "compose accent" | "streaming" | "human edit"
  | "summary" | "bookmark · canon" | "bookmark · alt" | "bookmark · draft"
  | "bookmark · discarded" | "danger" | "dimmed page";

interface ThemeExtras {
  brassDim: string;
  humanEditDim: string;
  dangerText: string;
  contextWarning: string;
  freshIntermediate: [string, string];
  /** Light themes land fresh ink wet-dark and bold (spec §10 polarity rule). */
  freshBold: boolean;
}

type ThemeTable = Record<PaletteRole, string> & ThemeExtras;

interface ThemeExtras256 {
  brassDim: number;
  humanEditDim: number;
  dangerText: number;
  contextWarning: number;
  freshIntermediate: [number, number];
}

type ThemeTable256 = Record<PaletteRole, number> & ThemeExtras256;

/** Spec §10 core roles; secondary roles shifted with each theme's temperature. */
const THEMES: Record<ThemeName, ThemeTable> = {
  "lantern": {
    background: "#14100B", raised: "#1B150E", chrome: "#6E604C",
    prose: "#E9DFC9", "prose · dim": "#9A8A70",
    "focus / accent": "#FFB454", "accent · deep": "#C8933F",
    "compose accent": "#8FB4D9",
    streaming: "#FFF2D8", "human edit": "#8FB4D9", summary: "#C9B58F",
    "bookmark · canon": "#E3B341", "bookmark · alt": "#C49AC4",
    "bookmark · draft": "#9FB6C4", "bookmark · discarded": "#7A7166",
    danger: "#E0603F", "dimmed page": "#5A4E3C",
    brassDim: "#8A7440", humanEditDim: "#7E9DBC", dangerText: "#FF8A65", contextWarning: "#D99028",
    freshIntermediate: ["#F8EAD0", "#F0E4CC"], freshBold: false
  },
  "iron gall": {
    background: "#0D1014", raised: "#12161B", chrome: "#4E5A66",
    prose: "#D8DEE4", "prose · dim": "#8B96A0",
    "focus / accent": "#A8C0D8", "accent · deep": "#6E87A0",
    "compose accent": "#D9A96C",
    streaming: "#EEF4FA", "human edit": "#D9A96C", summary: "#A9B4BE",
    "bookmark · canon": "#D4B254", "bookmark · alt": "#B9A0C9",
    "bookmark · draft": "#8FB0C4", "bookmark · discarded": "#66707A",
    danger: "#E0603F", "dimmed page": "#3C4750",
    brassDim: "#54687C", humanEditDim: "#B08A5A", dangerText: "#FF8A65", contextWarning: "#D9A96C",
    freshIntermediate: ["#E2E9F0", "#DCE4EC"], freshBold: false
  },
  "parchment": {
    background: "#F2EAD9", raised: "#EAE0CB", chrome: "#7A6748",
    prose: "#2A2016", "prose · dim": "#5C4E36",
    "focus / accent": "#9A5A10", "accent · deep": "#7A4A08",
    "compose accent": "#2C5578",
    streaming: "#0F0A04", "human edit": "#2C5578", summary: "#6E5A3A",
    "bookmark · canon": "#8A6510", "bookmark · alt": "#8A5A8A",
    "bookmark · draft": "#4A7086", "bookmark · discarded": "#948A7A",
    danger: "#A8331A", "dimmed page": "#B4A588",
    brassDim: "#7A6748", humanEditDim: "#466B89", dangerText: "#A8331A", contextWarning: "#8A4A00",
    freshIntermediate: ["#241A0E", "#2A2013"], freshBold: true
  },
  "bond": {
    background: "#F4F2ED", raised: "#ECEAE3", chrome: "#6C685E",
    prose: "#222426", "prose · dim": "#55585C",
    "focus / accent": "#A8321E", "accent · deep": "#7A2416",
    "compose accent": "#235A8C",
    streaming: "#0A0C0E", "human edit": "#235A8C", summary: "#6A5F4A",
    "bookmark · canon": "#7A6010", "bookmark · alt": "#7E5A8A",
    "bookmark · draft": "#3E6E8E", "bookmark · discarded": "#8E8A80",
    danger: "#8E1F10", "dimmed page": "#B8B4AA",
    brassDim: "#6C685E", humanEditDim: "#3C6994", dangerText: "#8E1F10", contextWarning: "#8A5A00",
    freshIntermediate: ["#1A1C1E", "#212426"], freshBold: true
  },
  "hi-contrast dark": {
    background: "#000000", raised: "#0D0D0D", chrome: "#9A9A9A",
    prose: "#FFFFFF", "prose · dim": "#C4C4C4",
    "focus / accent": "#FFC400", "accent · deep": "#FFC400",
    "compose accent": "#6FB8FF",
    streaming: "#FFFFFF", "human edit": "#6FB8FF", summary: "#E6E6E6",
    "bookmark · canon": "#FFD84D", "bookmark · alt": "#FFB8FF",
    "bookmark · draft": "#8FD8FF", "bookmark · discarded": "#C4C4C4",
    danger: "#FF5A45", "dimmed page": "#9A9A9A",
    brassDim: "#FFD84D", humanEditDim: "#9ACBFF", dangerText: "#FF8A7A", contextWarning: "#FF8C00",
    freshIntermediate: ["#FFFFFF", "#FFFFFF"], freshBold: false
  },
  "hi-contrast light": {
    background: "#FFFFFF", raised: "#F2F2F2", chrome: "#4A4A4A",
    prose: "#000000", "prose · dim": "#333333",
    "focus / accent": "#9A3800", "accent · deep": "#8A2000",
    "compose accent": "#144E86",
    streaming: "#000000", "human edit": "#144E86", summary: "#333333",
    "bookmark · canon": "#6A4A00", "bookmark · alt": "#6A2D70",
    "bookmark · draft": "#164F73", "bookmark · discarded": "#4A4A4A",
    danger: "#A00000", "dimmed page": "#4A4A4A",
    brassDim: "#6A4A00", humanEditDim: "#144E86", dangerText: "#A00000", contextWarning: "#8A5200",
    freshIntermediate: ["#000000", "#000000"], freshBold: true
  }
};

/**
 * Pinned xterm-256 remaps. These are deliberately not nearest-color guesses:
 * subtle truecolor temperatures otherwise collapse to the same gray (notably
 * lantern background/raised and parchment paper/chrome). Each theme keeps its
 * own polarity, accent temperature, and distinguishable surface levels.
 */
const THEMES_256: Record<ThemeName, ThemeTable256> = {
  lantern: {
    background: 233, raised: 234, chrome: 241,
    prose: 187, "prose · dim": 101,
    "focus / accent": 215, "accent · deep": 179,
    "compose accent": 110,
    streaming: 230, "human edit": 110, summary: 180,
    "bookmark · canon": 178, "bookmark · alt": 139,
    "bookmark · draft": 109, "bookmark · discarded": 243,
    danger: 166, "dimmed page": 240,
    brassDim: 137, humanEditDim: 109, dangerText: 209, contextWarning: 172,
    freshIntermediate: [224, 223]
  },
  "iron gall": {
    background: 233, raised: 234, chrome: 240,
    prose: 253, "prose · dim": 246,
    "focus / accent": 153, "accent · deep": 110,
    "compose accent": 179,
    streaming: 255, "human edit": 179, summary: 249,
    "bookmark · canon": 185, "bookmark · alt": 146,
    "bookmark · draft": 110, "bookmark · discarded": 242,
    danger: 203, "dimmed page": 238,
    brassDim: 60, humanEditDim: 179, dangerText: 215, contextWarning: 179,
    freshIntermediate: [254, 253]
  },
  parchment: {
    background: 230, raised: 187, chrome: 59,
    prose: 234, "prose · dim": 239,
    "focus / accent": 130, "accent · deep": 94,
    "compose accent": 24,
    streaming: 232, "human edit": 24, summary: 95,
    "bookmark · canon": 94, "bookmark · alt": 96,
    "bookmark · draft": 60, "bookmark · discarded": 245,
    danger: 124, "dimmed page": 144,
    brassDim: 59, humanEditDim: 61, dangerText: 124, contextWarning: 94,
    freshIntermediate: [234, 235]
  },
  bond: {
    background: 255, raised: 254, chrome: 241,
    prose: 235, "prose · dim": 240,
    "focus / accent": 130, "accent · deep": 88,
    "compose accent": 25,
    streaming: 232, "human edit": 25, summary: 95,
    "bookmark · canon": 94, "bookmark · alt": 96,
    "bookmark · draft": 61, "bookmark · discarded": 245,
    danger: 124, "dimmed page": 249,
    brassDim: 241, humanEditDim: 61, dangerText: 124, contextWarning: 94,
    freshIntermediate: [234, 235]
  },
  "hi-contrast dark": {
    background: 16, raised: 233, chrome: 247,
    prose: 231, "prose · dim": 251,
    "focus / accent": 220, "accent · deep": 220,
    "compose accent": 81,
    streaming: 231, "human edit": 81, summary: 254,
    "bookmark · canon": 227, "bookmark · alt": 225,
    "bookmark · draft": 159, "bookmark · discarded": 251,
    danger: 203, "dimmed page": 247,
    brassDim: 227, humanEditDim: 153, dangerText: 216, contextWarning: 208,
    freshIntermediate: [231, 231]
  },
  "hi-contrast light": {
    background: 231, raised: 255, chrome: 239,
    prose: 16, "prose · dim": 236,
    "focus / accent": 130, "accent · deep": 124,
    "compose accent": 24,
    streaming: 16, "human edit": 24, summary: 236,
    "bookmark · canon": 58, "bookmark · alt": 53,
    "bookmark · draft": 24, "bookmark · discarded": 239,
    danger: 124, "dimmed page": 239,
    brassDim: 58, humanEditDim: 24, dangerText: 124, contextWarning: 94,
    freshIntermediate: [16, 16]
  }
};

export type ColorDepth = "truecolor" | "256";

export interface Palette {
  depth: ColorDepth;
  theme: ThemeName;
  color(role: PaletteRole): ColorInput;
  brassDim: ColorInput;
  humanEditDim: ColorInput;
  dangerText: ColorInput;
  contextWarning: ColorInput;
  freshIntermediate: readonly [ColorInput, ColorInput];
  freshBold: boolean;
}

export function detectColorDepth(env: Record<string, string | undefined> = process.env): ColorDepth {
  const colorTerm = env.COLORTERM?.toLowerCase() ?? "";
  if (colorTerm.includes("truecolor") || colorTerm.includes("24bit")) return "truecolor";
  return "256";
}

/** Nearest xterm-256 index for a hex color (6×6×6 cube + gray ramp). */
export function nearest256(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  const r = (value >> 16) & 0xff, g = (value >> 8) & 0xff, b = value & 0xff;
  const level = (channel: number) => channel < 48 ? 0 : channel < 115 ? 1 : Math.min(5, Math.round((channel - 35) / 40));
  const cube = [r, g, b].map(level);
  const cubeValue = (index: number) => index === 0 ? 0 : 55 + index * 40;
  const cubeIndex = 16 + 36 * cube[0]! + 6 * cube[1]! + cube[2]!;
  const cubeDistance = distance(r, g, b, cubeValue(cube[0]!), cubeValue(cube[1]!), cubeValue(cube[2]!));
  const gray = Math.min(23, Math.max(0, Math.round((((r + g + b) / 3) - 8) / 10)));
  const grayLevel = 8 + gray * 10;
  const grayDistance = distance(r, g, b, grayLevel, grayLevel, grayLevel);
  return grayDistance < cubeDistance ? 232 + gray : cubeIndex;
}

function distance(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
  return (r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2;
}

export function createPalette(theme: ThemeName = "lantern", depth = detectColorDepth()): Palette {
  const table = THEMES[theme];
  const indexed = THEMES_256[theme];
  const pick = (hex: string, index: number): ColorInput => depth === "truecolor" ? hex : RGBA.fromIndex(index);
  return {
    depth,
    theme,
    color(role) { return pick(table[role], indexed[role]); },
    brassDim: pick(table.brassDim, indexed.brassDim),
    humanEditDim: pick(table.humanEditDim, indexed.humanEditDim),
    dangerText: pick(table.dangerText, indexed.dangerText),
    contextWarning: pick(table.contextWarning, indexed.contextWarning),
    freshIntermediate: [
      pick(table.freshIntermediate[0], indexed.freshIntermediate[0]),
      pick(table.freshIntermediate[1], indexed.freshIntermediate[1])
    ],
    freshBold: table.freshBold
  };
}

/** Exposed for contract tests and terminals that need to preflight colors. */
export function theme256Index(theme: ThemeName, role: PaletteRole): number {
  return THEMES_256[theme][role];
}

export function theme256ContextWarning(theme: ThemeName): number {
  return THEMES_256[theme].contextWarning;
}
