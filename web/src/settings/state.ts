import type { ModelServerCheckResult } from "../../../shared/types.js";
import type {
  DiscardPendingSettingsCommand,
  DiscoveredModelV2,
  SaveSettingsCommand,
  SettingsView
} from "../../../shared/settings-v2-types.js";
import type { SettingsTextDraft } from "../../../shared/settings-text-draft.js";

/** A save the page has built and may still have to send again. The same
 * `mutationId` goes out each time, so a lost answer never saves twice. The
 * draft and the keys are what the command was built from: edits made after
 * it are newer than the save. */
export interface SaveIntent {
  readonly command: Omit<SaveSettingsCommand, "transportOperationId">;
  readonly draft: SettingsTextDraft;
  readonly secrets: Readonly<Record<string, string | null>>;
}
export type DiscardIntent = Omit<DiscardPendingSettingsCommand, "transportOperationId">;

/** The model list the provider gave for one connection target. */
export type DiscoveryState =
  | { readonly target: string; readonly kind: "loading" }
  | { readonly target: string; readonly kind: "ready"; readonly models: readonly DiscoveredModelV2[]; readonly observedAt: string }
  | { readonly target: string; readonly kind: "failed"; readonly message: string };

export type CheckState =
  | { readonly target: string; readonly kind: "checking" }
  | { readonly target: string; readonly kind: "done"; readonly result: ModelServerCheckResult };

export type ProbeState =
  | { readonly kind: "probing" }
  | { readonly kind: "done"; readonly state: "ready" | "warning"; readonly message: string };

/** Text a field refused. The field keeps showing it, with the reason, and
 * the draft keeps the last value it accepted. */
export interface InvalidField {
  readonly text: string;
  readonly reason: string;
}

export interface SettingsNotice {
  readonly tone: "info" | "error";
  readonly text: string;
}

export interface LoadedSettings {
  readonly kind: "loaded";
  readonly view: SettingsView;
  /** The draft of the view as the server has it. */
  readonly base: SettingsTextDraft;
  readonly draft: SettingsTextDraft;
  /** Write-only key material, in memory only, keyed by secret id. A removed
   * key is `null`. It never goes to storage, a toast, or the Copy text. */
  readonly secrets: Readonly<Record<string, string | null>>;
  readonly invalid: Readonly<Record<string, InvalidField>>;
  /** Refused text of the fields that belong to a profile, kept for the
   * profiles the writer is not looking at. They come back with the profile. */
  readonly stashedInvalid: Readonly<Record<string, Readonly<Record<string, InvalidField>>>>;
  readonly discovery: DiscoveryState | null;
  readonly check: CheckState | null;
  readonly probe: ProbeState | null;
  readonly busy: "save" | "discard" | null;
  readonly saveIntent: SaveIntent | null;
  readonly discardIntent: DiscardIntent | null;
  readonly notice: SettingsNotice | null;
  /** Raised whenever the key field must start empty again. */
  readonly keyEpoch: number;
}

export type SettingsState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly message: string }
  | LoadedSettings;

export function initialSettingsState(): SettingsState {
  return { kind: "idle" };
}
