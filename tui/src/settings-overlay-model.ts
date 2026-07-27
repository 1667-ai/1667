import type {
  SettingsActivationErrorCodeV2,
  SettingsView
} from "../../shared/settings-v2-types.js";
import type { GenerationSettings } from "../../shared/types.js";
import type { UserConfig } from "./config.js";
import { THEME_NAMES, type ThemeName } from "./config.js";
import {
  createComposer,
  setComposerText,
  type ComposerState
} from "./composer-model.js";
import { graphemeCells } from "./cell-width.js";
import { promptCacheSummary } from "./settings-cache-summary.js";
import {
  localProviderPresetsSupported,
  nextSettingsProviderChoice,
  settingsProviderChoice,
  type SettingsProviderChoice
} from "./settings-provider-choices.js";
import {
  parseSettings,
  settingsTextDraftForView,
  type SettingsTextDraft
} from "./settings-text.js";
import type {
  SettingsOverlayState,
  SettingsRowId
} from "./state.js";
import {
  applyStoredApiKeyEdit,
  hasStoredApiKey,
  rekeyPendingStoredSecret,
  sameConnectionSecrets,
  storedApiKeyPresentation
} from "./settings-secret-sidecar.js";

export { applyStoredApiKeyIntent } from "./settings-secret-sidecar.js";

export const SETTINGS_ROW_IDS = [
  "theme",
  "compose-focus",
  "provider",
  "base-url",
  "allow-insecure-http",
  "model",
  "api-key",
  "api-key-env",
  "temperature",
  "max-tokens",
  "context-window",
  "cache-policy",
  "system-prompt"
] as const satisfies readonly SettingsRowId[];

export interface SettingsRowPresentation {
  readonly id: SettingsRowId;
  readonly label: string;
  readonly value: string;
}

const SETTINGS_FIELD_KEYS = {
  provider: "provider",
  "base-url": "baseUrl",
  model: "model",
  "api-key-env": "apiKeyEnv",
  temperature: "temperature",
  "max-tokens": "maxTokens",
  "context-window": "contextWindow",
  "cache-policy": "cachePolicy",
  "system-prompt": "systemPrompt"
} as const satisfies Record<
  Exclude<
    SettingsRowId,
    "theme" | "compose-focus" | "allow-insecure-http" | "api-key"
  >,
  string
>;

export function initialSettingsOverlay(
  view: SettingsView,
  config: UserConfig
): SettingsOverlayState {
  const draft = settingsTextDraftForView(view);
  return {
    view,
    base: draft,
    draft,
    connectionSecrets: {},
    cursor: 0,
    edit: null,
    conflict: null,
    checking: false,
    probing: false,
    result: null
  };
}

export function settingsRows(
  overlay: SettingsOverlayState,
  config: UserConfig
): readonly SettingsRowPresentation[] {
  const settings = overlay.draft.generation;
  const providerChoice = settingsProviderChoice(settings);
  const providerLabel =
    providerChoice.plaintextDefaultRequiresOwnedLoopback === true
    && !localProviderPresetsSupported()
    && isPlainHttp(settings.baseUrl)
    ? `${providerChoice.label} · unavailable`
    : providerChoice.label;
  return [
    { id: "theme", label: "theme", value: `‹ ${config.theme} ›` },
    { id: "compose-focus", label: "compose focus", value: `[ ${config.composeFocus} ]` },
    {
      id: "provider",
      label: "provider",
      value: `‹ ${providerLabel} ›`
    },
    { id: "base-url", label: "base URL", value: settings.baseUrl || "—" },
    {
      id: "allow-insecure-http",
      label: "Allow insecure HTTP (LAN)",
      value: `[ ${settings.allowInsecureHttp === true ? "on" : "off"} ]`
    },
    { id: "model", label: "model", value: settings.model || "—" },
    { id: "api-key", label: "API key", value: storedApiKeyPresentation(overlay) },
    { id: "api-key-env", label: "API key env", value: settings.apiKeyEnv ?? "—" },
    {
      id: "temperature",
      label: "temperature",
      value: settings.temperature?.toString() ?? "default"
    },
    {
      id: "max-tokens",
      label: "max tokens",
      value: settings.maxTokens.toLocaleString("en-US")
    },
    {
      id: "context-window",
      label: "context window",
      value: settings.contextWindow?.toLocaleString("en-US") ?? "unknown"
    },
    {
      id: "cache-policy",
      label: "cache policy",
      value: promptCacheSummary(overlay.view, overlay.draft)
    },
    {
      id: "system-prompt",
      label: "system prompt",
      value: settings.systemPrompt.replace(/\s+/g, " ")
    }
  ];
}

export function settingsRowEditValue(
  overlay: SettingsOverlayState,
  config: UserConfig,
  row: SettingsRowId
): string {
  if (row === "theme") return config.theme;
  if (row === "compose-focus") return config.composeFocus;
  if (row === "allow-insecure-http") {
    return overlay.draft.generation.allowInsecureHttp === true ? "on" : "off";
  }
  return draftRowEditValue(overlay.draft, row);
}

export function beginSettingsRowEdit(
  overlay: SettingsOverlayState,
  config: UserConfig
): void {
  const row = SETTINGS_ROW_IDS[boundedSettingsCursor(overlay.cursor)]!;
  if (settingsRowUsesServer(row)) overlay.result = null;
  const initial = settingsRowEditValue(overlay, config, row);
  const composer = createComposer(initial);
  if (initial.length > 0) composer.anchor = 0;
  overlay.edit = {
    row,
    mode: row === "api-key" ? "secret" : "text",
    composer,
    initial
  };
}

/** Same grapheme offsets as the write-only buffer; no secret code units cross
 * into rendered text, terminal selection, or clipboard projection. */
export function settingsEditDisplayComposer(
  edit: NonNullable<SettingsOverlayState["edit"]>
): ComposerState {
  if (edit.mode === "text") return edit.composer;
  const projection = createComposer(maskSecretText(edit.composer.text));
  projection.cursor = edit.composer.cursor;
  projection.anchor = edit.composer.anchor;
  projection.fullscreen = edit.composer.fullscreen;
  return projection;
}

export function beginSettingsPasteEdit(
  overlay: SettingsOverlayState,
  config: UserConfig
): boolean {
  if (overlay.edit !== null) return true;
  const row = SETTINGS_ROW_IDS[boundedSettingsCursor(overlay.cursor)]!;
  if (
    row === "theme"
    || row === "provider"
    || row === "allow-insecure-http"
  ) return false;
  if (settingsRowUsesServer(row) && !overlay.view.editable) {
    return false;
  }
  beginSettingsRowEdit(overlay, config);
  return true;
}

export function applySettingsRowEdit(
  overlay: SettingsOverlayState,
  config: UserConfig
): { kind: "theme"; value: ThemeName }
  | { kind: "compose-focus"; value: UserConfig["composeFocus"] }
  | { kind: "draft" }
  | { kind: "error"; message: string } {
  const edit = overlay.edit;
  if (edit === null) return { kind: "error", message: "no settings row is being edited" };
  const rawValue = edit.composer.text;
  const value = rawValue.trim();
  if (edit.row === "theme") {
    if (!THEME_NAMES.includes(value as ThemeName)) {
      return { kind: "error", message: `theme must be ${THEME_NAMES.join(", ")}` };
    }
    overlay.edit = null;
    return { kind: "theme", value: value as ThemeName };
  }
  if (edit.row === "compose-focus") {
    if (value !== "on" && value !== "off") {
      return { kind: "error", message: "compose focus must be on or off" };
    }
    overlay.edit = null;
    return { kind: "compose-focus", value };
  }
  if (edit.row === "api-key") {
    const result = applyStoredApiKeyEdit(overlay, rawValue);
    if (result !== null) return { kind: "error", message: result };
    overlay.edit = null;
    overlay.result = null;
    if (!settingsDraftChanged(overlay)) overlay.conflict = null;
    return { kind: "draft" };
  }
  if (edit.row === "allow-insecure-http") {
    return { kind: "error", message: "insecure HTTP is a selector" };
  }
  if (edit.row === "system-prompt") {
    const systemPrompt = parseInlineSystemPrompt(edit.composer.text);
    if (typeof systemPrompt !== "string") return systemPrompt;
    const parsed = {
      ...overlay.draft,
      generation: { ...overlay.draft.generation, systemPrompt }
    };
    overlay.draft = parsed;
    if (sameSettingsDraft(parsed, overlay.base)) overlay.conflict = null;
    overlay.edit = null;
    overlay.result = null;
    return { kind: "draft" };
  }

  const parsed = parseSettings(
    `${SETTINGS_FIELD_KEYS[edit.row]}: ${value}`,
    overlay.draft
  );
  if ("error" in parsed) return { kind: "error", message: parsed.error };
  const identityChanged = (
    edit.row === "base-url"
      && parsed.generation.baseUrl !== overlay.draft.generation.baseUrl
  ) || (
    edit.row === "model"
      && parsed.generation.model !== overlay.draft.generation.model
  );
  const next = identityChanged
    ? {
        ...parsed,
        generation: { ...parsed.generation, contextWindow: null }
      }
    : parsed;
  overlay.draft = next;
  if (edit.row === "api-key-env") overlay.connectionSecrets = {};
  if (!settingsDraftChanged(overlay)) overlay.conflict = null;
  overlay.edit = null;
  overlay.result = null;
  return { kind: "draft" };
}

/** One spelling for every surface that reports why an activation failed. */
export function settingsActivationFailureText(
  errorCode: SettingsActivationErrorCodeV2
): string {
  switch (errorCode) {
    case "credential_unresolved":
      return "credential not found (env var or stored key)";
    case "candidate_invalid":
      return "provider check failed";
    case "activation_crashed":
      return "activation was interrupted";
    case "activation_failed":
    case "readiness_failed":
      return "activation rolled back";
  }
}

export function settingsDraftChanged(overlay: SettingsOverlayState): boolean {
  return !sameSettingsDraft(overlay.draft, overlay.base)
    || Object.keys(overlay.connectionSecrets).length > 0;
}

export function sameSettingsDraft(
  left: SettingsTextDraft,
  right: SettingsTextDraft
): boolean {
  return left.cachePolicy === right.cachePolicy
    && sameGenerationSettings(left.generation, right.generation);
}

export function boundedSettingsCursor(value: number): number {
  return Math.max(0, Math.min(SETTINGS_ROW_IDS.length - 1, value));
}

/** Rows whose value is a closed choice: `←→` cycles them in place and their
 * value's brackets are click targets. Everything else is free text the row
 * editor owns. One spelling of the set, read by the panel and the key handler.
 *
 * Deliberately not the inverse of `settingsRowUsesServer`: provider cycles and
 * is server-backed, while theme and compose focus cycle and are local. */
export function settingsRowCycles(row: SettingsRowId): boolean {
  return row === "theme"
    || row === "compose-focus"
    || row === "provider"
    || row === "allow-insecure-http";
}

/** Local-only rows live in the user config; every other row edits a
 * server-backed settings revision. */
export function settingsRowUsesServer(row: SettingsRowId): boolean {
  return row !== "theme" && row !== "compose-focus";
}

export function cycleSettingsProvider(
  overlay: SettingsOverlayState,
  step: -1 | 1
): SettingsProviderChoice {
  const choice = nextSettingsProviderChoice(overlay.draft.generation, step);
  const preserveStoredApiKey = hasStoredApiKey(overlay);
  overlay.draft = {
    ...overlay.draft,
    generation: {
      ...overlay.draft.generation,
      provider: choice.provider,
      ...choice.defaults,
      ...(preserveStoredApiKey ? { apiKeyEnv: null } : {})
    }
  };
  rekeyPendingStoredSecret(overlay);
  overlay.result = null;
  if (!settingsDraftChanged(overlay)) overlay.conflict = null;
  else if (overlay.conflict !== null) overlay.conflict.armed = false;
  return choice;
}

/** Rebase a clean menu refresh; preserve dirty row drafts and require an
 * explicit overwrite when the authoritative document changed underneath it. */
export function reconcileSettingsOverlay(
  overlay: SettingsOverlayState,
  view: SettingsView
): string | null {
  const nextBase = settingsTextDraftForView(view);
  const baseChanged = !sameSettingsDraft(overlay.base, nextBase);
  if (!baseChanged) {
    overlay.base = nextBase;
    return null;
  }

  const draftWasClean = !settingsDraftChanged(overlay);
  const edit = overlay.edit;
  const editAffectsServer = edit !== null
    && edit.row !== "theme"
    && edit.row !== "compose-focus";
  const editWasClean = !editAffectsServer || edit.composer.text === edit.initial;
  const activeDraft = editAffectsServer && !editWasClean
    ? draftWithActiveEdit(overlay)
    : overlay.draft;
  const converged = activeDraft !== null && sameSettingsDraft(activeDraft, nextBase);
  if (draftWasClean || converged) {
    overlay.draft = nextBase;
  }
  overlay.base = nextBase;

  if (edit !== null && (draftWasClean || converged) && editWasClean
    && edit.row !== "theme"
    && edit.row !== "compose-focus"
    && edit.row !== "allow-insecure-http") {
    const refreshed = draftRowEditValue(overlay.draft, edit.row);
    setComposerText(edit.composer, refreshed);
    if (refreshed.length > 0) edit.composer.anchor = 0;
    edit.initial = refreshed;
  }

  if (converged) {
    if (editAffectsServer && !editWasClean) edit.initial = edit.composer.text;
    overlay.conflict = null;
    return "settings changed during refresh · draft now current";
  }
  if (draftWasClean && editWasClean) {
    overlay.conflict = null;
    return "settings changed during refresh · menu refreshed";
  }
  overlay.conflict = {
    message: "settings changed during refresh · draft kept",
    armed: false
  };
  return overlay.conflict.message;
}

export function settleSettingsOverlaySave(
  overlay: SettingsOverlayState,
  acknowledged: SettingsTextDraft,
  acknowledgedSecrets: Readonly<Record<string, string | null>> = {}
): boolean {
  const newerDraft = !sameSettingsDraft(overlay.draft, acknowledged)
    || !sameConnectionSecrets(overlay.connectionSecrets, acknowledgedSecrets);
  if (sameConnectionSecrets(overlay.connectionSecrets, acknowledgedSecrets)) {
    overlay.connectionSecrets = {};
  }
  const nextBase = settingsTextDraftForView(overlay.view);
  overlay.base = nextBase;
  if (!newerDraft) {
    overlay.draft = nextBase;
  }
  overlay.conflict = null;
  return newerDraft || (
    overlay.edit !== null && overlay.edit.composer.text !== overlay.edit.initial
  );
}

export function sameGenerationSettings(
  left: GenerationSettings,
  right: GenerationSettings
): boolean {
  return left.provider === right.provider
    && left.baseUrl === right.baseUrl
    && left.model === right.model
    && left.apiKeyEnv === right.apiKeyEnv
    && left.allowInsecureHttp === right.allowInsecureHttp
    && left.temperature === right.temperature
    && left.maxTokens === right.maxTokens
    && left.contextWindow === right.contextWindow
    && left.systemPrompt === right.systemPrompt;
}

function draftRowEditValue(
  draft: SettingsTextDraft,
  row: Exclude<
    SettingsRowId,
    "theme" | "compose-focus" | "allow-insecure-http"
  >
): string {
  const settings = draft.generation;
  if (row === "provider") return settings.provider;
  if (row === "base-url") return settings.baseUrl;
  if (row === "model") return settings.model;
  if (row === "api-key") return "";
  if (row === "api-key-env") return settings.apiKeyEnv ?? "";
  if (row === "temperature") return settings.temperature?.toString() ?? "";
  if (row === "max-tokens") return settings.maxTokens.toString();
  if (row === "context-window") return settings.contextWindow?.toString() ?? "";
  if (row === "cache-policy") return draft.cachePolicy;
  return JSON.stringify(settings.systemPrompt);
}

function draftWithActiveEdit(
  overlay: SettingsOverlayState
): SettingsTextDraft | null {
  const edit = overlay.edit;
  if (edit === null || edit.row === "theme" || edit.row === "compose-focus") {
    return overlay.draft;
  }
  if (edit.row === "api-key" || edit.row === "allow-insecure-http") {
    return edit.composer.text === edit.initial ? overlay.draft : null;
  }
  if (edit.row === "system-prompt") {
    const systemPrompt = parseInlineSystemPrompt(edit.composer.text);
    return typeof systemPrompt === "string"
      ? {
          ...overlay.draft,
          generation: { ...overlay.draft.generation, systemPrompt }
        }
      : null;
  }
  const parsed = parseSettings(
    `${SETTINGS_FIELD_KEYS[edit.row]}: ${edit.composer.text}`,
    overlay.draft
  );
  return "error" in parsed ? null : parsed;
}

export function cycleAllowInsecureHttp(overlay: SettingsOverlayState): boolean {
  const allowInsecureHttp = overlay.draft.generation.allowInsecureHttp !== true;
  const generation = { ...overlay.draft.generation };
  if (allowInsecureHttp) generation.allowInsecureHttp = true;
  else delete generation.allowInsecureHttp;
  overlay.draft = {
    ...overlay.draft,
    generation
  };
  overlay.result = null;
  if (!settingsDraftChanged(overlay)) overlay.conflict = null;
  else if (overlay.conflict !== null) overlay.conflict.armed = false;
  return allowInsecureHttp;
}

/** Existing prompts enter as a JSON string so one-line editing has a
 * reversible projection for newlines, tabs, quotes, and repeated spaces.
 * Replacing the selected seed with ordinary text remains the simple path. */
function parseInlineSystemPrompt(value: string): string | { kind: "error"; message: string } {
  const trimmed = value.trim();
  if (!trimmed.startsWith("\"")) return trimmed;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "string"
      ? parsed
      : { kind: "error", message: "system prompt must be a JSON string or plain text" };
  } catch {
    return {
      kind: "error",
      message: "system prompt has invalid JSON string escapes or quotes"
    };
  }
}

function isPlainHttp(value: string): boolean {
  try {
    return new URL(value).protocol === "http:";
  } catch {
    return false;
  }
}

function maskSecretText(value: string): string {
  return graphemeCells(value)
    .map((cell) => /[\r\n]/u.test(cell.text) ? cell.text : "•")
    .join("");
}
