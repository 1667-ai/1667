import {
  PROMPT_CACHE_POLICY_V2_VALUES,
  type PromptCachePolicyV2,
  type SettingsActivationErrorCodeV2,
  type SettingsView
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
import {
  promptCacheSummaryParts,
  type PromptCacheSummaryParts
} from "./settings-cache-summary.js";
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
  SettingsInlineEditState,
  SettingsOverlayState,
  SettingsRowId
} from "./state.js";
import type { ActiveSettingsEdit } from "./settings-edit-state.js";
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
  config: UserConfig,
  cacheSummary: PromptCacheSummaryParts = promptCacheSummaryParts(
    overlay.view,
    overlay.draft
  )
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
      label: "insecure HTTP (LAN)",
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
      value: `‹ ${cacheSummary.policy} › · ${cacheSummary.detail}`
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
  if (row === "system-prompt") return;
  if (settingsRowUsesServer(row)) overlay.result = null;
  const initial = settingsRowEditValue(overlay, config, row);
  const composer = createComposer(initial);
  if (initial.length > 0) composer.anchor = 0;
  overlay.edit = {
    kind: "inline",
    row,
    mode: row === "api-key" ? "secret" : "text",
    composer,
    initial
  };
}

/** Any Settings draft change invalidates prior overwrite consent. */
export function disarmSettingsConflict(overlay: SettingsOverlayState): void {
  if (overlay.conflict !== null) overlay.conflict.armed = false;
}

/** Same grapheme offsets as the write-only buffer; no secret code units cross
 * into rendered text, terminal selection, or clipboard projection. */
export function settingsEditDisplayComposer(
  edit: SettingsInlineEditState
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
  if (row === "system-prompt") return false;
  // Closed choices cycle in place; paste must not open their row editor.
  if (settingsRowCycles(row)) return false;
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
  if (edit?.kind !== "inline") {
    return { kind: "error", message: "no settings row is being edited" };
  }
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

export function applySystemPromptDraft(
  overlay: SettingsOverlayState,
  systemPrompt: string
): void {
  disarmSettingsConflict(overlay);
  overlay.draft = {
    ...overlay.draft,
    generation: {
      ...overlay.draft.generation,
      systemPrompt
    }
  };
  if (sameSettingsDraft(overlay.draft, overlay.base)) overlay.conflict = null;
  overlay.result = null;
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
      return "rolled back after an interruption";
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
 * A cycling value may keep read-only detail after its closing bracket — the
 * cache policy states what the choice costs — so the panel finds the arrows by
 * bracket, not by the ends of the value.
 *
 * Deliberately not the inverse of `settingsRowUsesServer`: provider cycles and
 * is server-backed, while theme and compose focus cycle and are local. */
export function settingsRowCycles(row: SettingsRowId): boolean {
  return row === "theme"
    || row === "compose-focus"
    || row === "provider"
    || row === "allow-insecure-http"
    || row === "cache-policy";
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
  else disarmSettingsConflict(overlay);
  return choice;
}

/** Rebase a clean menu refresh; preserve dirty row drafts and require an
 * explicit overwrite when the authoritative document changed underneath it. */
export function reconcileSettingsOverlay(
  overlay: SettingsOverlayState,
  view: SettingsView,
  edit: ActiveSettingsEdit | null
): string | null {
  const nextBase = settingsTextDraftForView(view);
  const baseChanged = !sameSettingsDraft(overlay.base, nextBase);
  if (!baseChanged) {
    overlay.base = nextBase;
    return null;
  }

  const draftWasClean = !settingsDraftChanged(overlay);
  const editRow = edit?.row ?? null;
  const editAffectsServer = edit !== null
    && editRow !== "theme"
    && editRow !== "compose-focus";
  const editWasClean = !editAffectsServer
    || edit.composer.text === edit.initialText();
  const activeEditBase = draftWasClean ? nextBase : overlay.draft;
  const activeDraft = editAffectsServer && !editWasClean
    ? draftWithActiveEdit(activeEditBase, edit)
    : overlay.draft;
  const converged = activeDraft !== null && sameSettingsDraft(activeDraft, nextBase);
  if (draftWasClean || converged) {
    overlay.draft = nextBase;
  }
  overlay.base = nextBase;

  if (edit !== null && (draftWasClean || converged) && editWasClean
    && editRow !== null
    && settingsDraftTextRow(editRow)) {
    const refreshed = draftRowEditValue(overlay.draft, editRow);
    setComposerText(edit.composer, refreshed);
    if (refreshed.length > 0) edit.composer.anchor = 0;
    edit.setInitialText(refreshed);
  }

  if (converged) {
    if (editAffectsServer && !editWasClean) {
      edit.setInitialText(edit.composer.text);
    }
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
  edit: ActiveSettingsEdit | null,
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
    edit !== null && edit.composer.text !== edit.initialText()
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
  return settings.systemPrompt;
}

function draftWithActiveEdit(
  draft: SettingsTextDraft,
  edit: ActiveSettingsEdit
): SettingsTextDraft | null {
  const row = edit.row;
  if (row === "theme" || row === "compose-focus") {
    return draft;
  }
  if (row === "api-key" || row === "allow-insecure-http") {
    return edit.composer.text === edit.initialText() ? draft : null;
  }
  if (row === "system-prompt") {
    return {
      ...draft,
      generation: {
        ...draft.generation,
        systemPrompt: edit.composer.text
      }
    };
  }
  const parsed = parseSettings(
    `${SETTINGS_FIELD_KEYS[row]}: ${edit.composer.text}`,
    draft
  );
  return "error" in parsed ? null : parsed;
}

function settingsDraftTextRow(
  row: SettingsRowId
): row is Exclude<
  SettingsRowId,
  "theme" | "compose-focus" | "allow-insecure-http"
> {
  return row !== "theme"
    && row !== "compose-focus"
    && row !== "allow-insecure-http";
}

/** Every policy stays reachable, including one this exact model cannot honour.
 * The row summary then reads `unavailable`, and the choice becomes live again
 * when the model changes. A skipped choice would vanish without a reason. */
export function cyclePromptCachePolicy(
  overlay: SettingsOverlayState,
  step: -1 | 1
): PromptCachePolicyV2 {
  const values = PROMPT_CACHE_POLICY_V2_VALUES;
  const index = values.indexOf(overlay.draft.cachePolicy);
  const cachePolicy = values[(index + step + values.length) % values.length]!;
  overlay.draft = { ...overlay.draft, cachePolicy };
  overlay.result = null;
  if (!settingsDraftChanged(overlay)) overlay.conflict = null;
  else disarmSettingsConflict(overlay);
  return cachePolicy;
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
  else disarmSettingsConflict(overlay);
  return allowInsecureHttp;
}

/** The cycled policy in brackets, then what the choice costs. The panel puts
 * the arrows on the brackets, so the detail has to stay outside them. */
export function promptCacheRowValue(
  view: SettingsView,
  draft?: SettingsTextDraft
): string {
  const parts = promptCacheSummaryParts(view, draft);
  return `‹ ${parts.policy} › · ${
    parts.kind === "available"
      ? parts.detail
      : `unavailable · ${parts.reason}`
  }`;
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
