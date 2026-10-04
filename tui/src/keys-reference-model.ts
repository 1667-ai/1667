import {
  KEYS_MODAL_MODEL as SHARED_KEYS_MODAL_MODEL,
  type KeysModalBinding,
  type KeysModalEntry,
  type KeysModalSection as SharedKeysModalSection
} from "../../shared/keys-reference-model.js";
import type { DisplayRole } from "./screens/story/frame.js";

export type { KeysModalBinding, KeysModalEntry };

/** The shared key reference plus the terminal colour each section is drawn in.
 *  The content lives in `shared/keys-reference-model.ts`, so the web reads the
 *  same rows; only the colours stay here. */
export interface KeysModalSection extends SharedKeysModalSection {
  role: DisplayRole;
}

export interface KeysModalModel {
  sections: readonly KeysModalSection[];
  bindings: readonly KeysModalBinding[];
}

const SECTION_ROLES: Readonly<Record<string, DisplayRole>> = {
  MOVE: "focus / accent",
  WRITE: "human edit",
  SHAPE: "tag · alt",
  OPEN: "tag · canon",
  MAP: "compose accent",
  SEARCH: "tag · draft"
};

export const KEYS_MODAL_MODEL: KeysModalModel = {
  sections: SHARED_KEYS_MODAL_MODEL.sections.map((section) => ({
    ...section,
    role: SECTION_ROLES[section.title]!
  })),
  bindings: SHARED_KEYS_MODAL_MODEL.bindings
};
