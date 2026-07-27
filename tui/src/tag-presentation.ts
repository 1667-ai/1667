import type { Tag, TagStatus } from "../../shared/types.js";
import type { PaletteRole } from "./palette.js";

export function tagStatusChoice(status: TagStatus): string {
  return status === "" ? "none" : status;
}

export function tagGlyph(status: TagStatus): string {
  if (status === "Summary") return "◈";
  if (status === "Draft") return "~";
  if (status === "Discarded") return "✕";
  return "⚑";
}

export function tagRole(tag: Tag | null): PaletteRole {
  if (tag === null) return "prose · dim";
  if (tag.status === "") return "prose · dim";
  if (tag.status === "Summary") return "summary";
  if (tag.status === "Alt") return "tag · alt";
  if (tag.status === "Draft") return "tag · draft";
  if (tag.status === "Discarded") return "tag · discarded";
  return "tag · canon";
}
