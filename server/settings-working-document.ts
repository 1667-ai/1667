import type { SettingsDocumentV5, SettingsStateV5 } from "../shared/settings-v5-types.js";
import { writingPromptSettingsFromAuthorBrief } from "../shared/settings-v5-writing.js";
import {
  convertSettingsDocumentV2ToV5,
  convertSettingsDocumentV3ToV5,
  convertSettingsDocumentV4ToV5
} from "./settings-v5-conversion.js";
import { convertSettingsStateSlotToV5 } from "./settings-state-authority.js";
import { settingsStateRelation } from "./settings-state-validation.js";
import type { SettingsStateSlot } from "./settings-state-slot.js";
import { effectiveSettingsStateRevision } from "./settings-state-validation.js";
import type { WritingPromptSettings } from "../shared/settings-v5-writing.js";

/** The document the editor shows: pending candidate when staged, otherwise
 *  the active revision, always as schema 5. */
export function workingSettingsDocument(slot: SettingsStateSlot): SettingsDocumentV5 {
  const state = convertSettingsStateSlotToV5(slot);
  return shownSettingsDocumentV5(state);
}

export function shownSettingsDocumentV5(state: SettingsStateV5): SettingsDocumentV5 {
  const pendingRevision = settingsStateRelation(state) === "committed"
    ? null
    : state.pendingRevision;
  const revision = pendingRevision === null
    ? effectiveSettingsStateRevision(state)
    : pendingRevision;
  return state.documents[String(revision)]!;
}

export function activeWritingFromSlot(slot: SettingsStateSlot): WritingPromptSettings {
  if (slot.kind === "v5") {
    const revision = effectiveSettingsStateRevision(slot.state);
    return slot.state.documents[String(revision)]!.writing;
  }
  if (slot.kind === "v4") {
    const revision = effectiveSettingsStateRevision(slot.state);
    return writingPromptSettingsFromAuthorBrief(
      slot.state.documents[String(revision)]!.writing.defaultAuthorBrief
    );
  }
  if (slot.kind === "v3") {
    const revision = effectiveSettingsStateRevision(slot.state);
    return writingPromptSettingsFromAuthorBrief(
      slot.state.documents[String(revision)]!.writing.defaultAuthorBrief
    );
  }
  const revision = effectiveSettingsStateRevision(slot.state);
  return writingPromptSettingsFromAuthorBrief(
    slot.state.documents[String(revision)]!.writing.defaultAuthorBrief
  );
}

export function convertWorkingDocumentFromSource(
  slot: SettingsStateSlot
): SettingsDocumentV5 {
  switch (slot.kind) {
    case "v2": {
      const revision = effectiveSettingsStateRevision(slot.state);
      return convertSettingsDocumentV2ToV5(slot.state.documents[String(revision)]!);
    }
    case "v3": {
      const revision = effectiveSettingsStateRevision(slot.state);
      return convertSettingsDocumentV3ToV5(slot.state.documents[String(revision)]!);
    }
    case "v4": {
      const revision = effectiveSettingsStateRevision(slot.state);
      return convertSettingsDocumentV4ToV5(slot.state.documents[String(revision)]!);
    }
    case "v5": {
      const revision = effectiveSettingsStateRevision(slot.state);
      return slot.state.documents[String(revision)]!;
    }
  }
}
