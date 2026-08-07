import { readProfileTransferFile } from "../../server/profile-transfer-decoder.js";
import { fidelityReport } from "../../shared/fidelity.js";
import type { ProfileTransferCandidate } from "../../shared/generation-profile-transfer.js";
import { STARTER_PROFILES } from "../../shared/generation-profile-starters.js";
import { completeFilePath, errorMessage, expandLeadingTilde } from "./path-completion.js";
import { recordNotice } from "./notice-log.js";
import { applyProfileTransfer } from "./profile-transfer-apply.js";
import { settingsTextDraftForDocument } from "./settings-text.js";
import { readFromClipboard } from "./clipboard.js";
import { pasteInto, type ResolvedKey } from "./keys.js";
import type {
  ProfileTransferPrompt,
  RuntimeState,
  SettingsOverlayState
} from "./state.js";

const FILE_SOURCE_INDEX = STARTER_PROFILES.length;
const PROFILE_TRANSFER_SOURCE_COUNT = FILE_SOURCE_INDEX + 1;

export interface ProfileTransferDependencies {
  readonly readFile?: typeof readProfileTransferFile;
  readonly readClipboard?: typeof readFromClipboard;
}

export function openProfileTransfer(overlay: SettingsOverlayState): void {
  overlay.profileTransfer = { phase: "source", cursor: 0, error: null };
}

export async function profileTransferAction(
  resolved: ResolvedKey,
  state: RuntimeState,
  overlay: SettingsOverlayState,
  dependencies: ProfileTransferDependencies = {}
): Promise<void> {
  const prompt = overlay.profileTransfer;
  if (prompt === null) return;
  if (resolved.action === "cancel") {
    overlay.profileTransfer = null;
    return;
  }
  if (prompt.phase === "source" && (resolved.action === "focus-next" || resolved.action === "focus-previous")) {
    prompt.cursor = (prompt.cursor + (resolved.action === "focus-next" ? 1 : PROFILE_TRANSFER_SOURCE_COUNT - 1)) % PROFILE_TRANSFER_SOURCE_COUNT;
    return;
  }
  if (prompt.phase === "source" && resolved.action === "focus-index") {
    prompt.cursor = Math.max(0, Math.min(PROFILE_TRANSFER_SOURCE_COUNT - 1, resolved.index ?? prompt.cursor));
    return;
  }
  if (prompt.phase === "file") {
    if (resolved.action === "input" || resolved.action === "backspace") {
      prompt.path = resolved.action === "input"
        ? prompt.path + (resolved.text ?? "")
        : [...prompt.path].slice(0, -1).join("");
      prompt.error = null;
      prompt.candidates = [];
    }
    else if (resolved.action === "paste-clipboard") {
      await pasteProfileTransferClipboard(
        state,
        prompt,
        overlay,
        dependencies.readClipboard ?? readFromClipboard
      );
    }
    else if (resolved.action === "complete") await completeFilePath(prompt);
    else if (resolved.action === "apply-profile-transfer") {
      await applyFile(
        prompt.path,
        state,
        prompt,
        overlay,
        dependencies.readFile ?? readProfileTransferFile
      );
    }
    return;
  }
  if (resolved.action !== "apply-profile-transfer" && resolved.action !== "open-selected") return;
  if (prompt.cursor === FILE_SOURCE_INDEX) {
    overlay.profileTransfer = { phase: "file", path: "", candidates: [], error: null };
    return;
  }
  if (overlay.draft.document === null || overlay.draft.selectedProfileId === null) return;
  const candidate = STARTER_PROFILES[prompt.cursor];
  if (candidate === undefined) return;
  applyCandidate(candidate, state, prompt, overlay);
}

async function pasteProfileTransferClipboard(
  state: RuntimeState,
  prompt: Extract<ProfileTransferPrompt, { readonly phase: "file" }>,
  overlay: SettingsOverlayState,
  readClipboard: typeof readFromClipboard
): Promise<void> {
  const claim = { interactionVersion: state.interactionVersion, path: prompt.path };
  const text = await readClipboard();
  if (!profileTransferCurrent(state, prompt, overlay)
    || state.interactionVersion !== claim.interactionVersion
    || prompt.path !== claim.path) {
    return;
  }
  if (text === null) {
    state.toast = "clipboard unreadable · paste with ⌘V or ctrl+shift+v";
  } else if (!pasteInto(state, text)) {
    state.toast = "clipboard has no insertable text";
  }
}

async function applyFile(
  path: string,
  state: RuntimeState,
  prompt: Extract<ProfileTransferPrompt, { readonly phase: "file" }>,
  overlay: SettingsOverlayState,
  readFile: typeof readProfileTransferFile
): Promise<void> {
  if (path.trim().length === 0) { prompt.error = "type a Sampler Preset or Profile Export path"; return; }
  const claim = { interactionVersion: state.interactionVersion, path };
  try {
    const candidate = await readFile(expandLeadingTilde(path));
    if (!profileTransferClaimCurrent(state, prompt, overlay, claim)) return;
    applyCandidate(candidate, state, prompt, overlay);
  } catch (error) {
    if (profileTransferClaimCurrent(state, prompt, overlay, claim)) {
      prompt.error = errorMessage(error);
    }
  }
}

function profileTransferClaimCurrent(
  state: RuntimeState,
  prompt: ProfileTransferPrompt,
  overlay: SettingsOverlayState,
  claim: { readonly interactionVersion: number; readonly path: string }
): boolean {
  return profileTransferCurrent(state, prompt, overlay)
    && state.interactionVersion === claim.interactionVersion
    && prompt.phase === "file"
    && prompt.path === claim.path;
}

function profileTransferCurrent(
  state: RuntimeState,
  prompt: ProfileTransferPrompt,
  overlay: NonNullable<RuntimeState["settings"]>
): boolean {
  return state.mode === "SETTINGS"
    && state.settings === overlay
    && overlay.profileTransfer === prompt;
}

function applyCandidate(
  candidate: ProfileTransferCandidate,
  state: RuntimeState,
  prompt: ProfileTransferPrompt,
  overlay: SettingsOverlayState
): void {
  const document = overlay.draft.document!;
  const sourceId = overlay.draft.selectedProfileId!;
  const fitted = applyProfileTransfer(document, sourceId, candidate);
  if ("error" in fitted) { prompt.error = fitted.error; return; }
  overlay.draft = settingsTextDraftForDocument(fitted.document, fitted.profileId);
  overlay.deleteArmedProfileId = null;
  overlay.result = null;
  if (overlay.conflict !== null) overlay.conflict.armed = false;
  overlay.profileTransfer = null;
  const importedName = fitted.document.profiles[fitted.profileId]!.name;
  const headline = `imported "${importedName}" · ${fitted.importedCount} of ${fitted.candidateCount} parameters · s saves settings`;
  state.toast = headline;
  recordNotice(state.notices, "toast", `${headline} · ${fidelityReport(fitted.fidelity)}`);
}
