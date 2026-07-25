import type { Bookmark } from "../../shared/types.js";
import type { PaletteRole } from "./palette.js";

export function bookmarkLabelChoice(label: Bookmark["label"]): string {
  return label === "" ? "none" : label;
}

export function bookmarkGlyph(label: Bookmark["label"]): string {
  if (label === "Summary") return "◈";
  if (label === "Draft") return "~";
  if (label === "Discarded") return "✕";
  return "⚑";
}

export function bookmarkRole(bookmark: Bookmark | null): PaletteRole {
  if (bookmark === null) return "prose · dim";
  if (bookmark.label === "") return "prose · dim";
  if (bookmark.label === "Summary") return "summary";
  if (bookmark.label === "Alt") return "bookmark · alt";
  if (bookmark.label === "Draft") return "bookmark · draft";
  if (bookmark.label === "Discarded") return "bookmark · discarded";
  return "bookmark · canon";
}
