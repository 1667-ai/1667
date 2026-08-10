import type { GenerationProfileV2 } from "../../shared/settings-v2-types.js";
import { replaceSettingsDraft } from "./settings-draft-transition.js";
import { settingsTextDraftForDocument } from "./settings-text.js";
import type { SettingsOverlayState } from "./state.js";

/** Shared C-09 cycler body. Every closed profile control differs only in
 *  which field it reads and writes and which choices it cycles through —
 *  the same two guards (no document, no selected profile), the same
 *  `indexOf`, the same modular-step landing.
 *
 *  `undefined` is the no-op sentinel rather than `null`, because a cycled
 *  value of `null` is itself a legitimate result — token probabilities'
 *  `off` — that must not be mistaken for "there was nothing to cycle". */
export function cycleProfileField<T>(
  overlay: SettingsOverlayState,
  step: -1 | 1,
  choices: readonly T[],
  read: (profile: GenerationProfileV2) => T,
  write: (profile: GenerationProfileV2, value: T) => GenerationProfileV2
): T | undefined {
  const document = overlay.draft.document;
  const profileId = overlay.draft.selectedProfileId;
  if (document === null || profileId === null) return undefined;
  const profile = document.profiles[profileId];
  if (profile === undefined) return undefined;
  const index = choices.indexOf(read(profile));
  const next = choices[index < 0
    ? 0
    : (index + step + choices.length) % choices.length]!;
  replaceSettingsDraft(
    overlay,
    settingsTextDraftForDocument({
      ...document,
      profiles: { ...document.profiles, [profileId]: write(profile, next) }
    }, profileId)
  );
  markControlMutation(overlay);
  return next;
}

/** Any closed control that writes the draft clears the transient chrome the
 *  previous value earned: an armed deletion, a stale check result, and an
 *  armed conflict. */
export function markControlMutation(overlay: SettingsOverlayState): void {
  overlay.deleteArmedProfileId = null;
  overlay.result = null;
  if (overlay.conflict !== null) overlay.conflict.armed = false;
}
