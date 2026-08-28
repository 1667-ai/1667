import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isSemVer } from "../../shared/semver.js";

export type ThemeName =
  | "lantern"
  | "iron gall"
  | "parchment"
  | "bond"
  | "graphite"
  | "bone"
  | "hi-contrast dark"
  | "hi-contrast light";

export const NEW_INSTALL_THEME: ThemeName = "graphite";

export const THEME_NAMES: readonly ThemeName[] = [
  "lantern",
  "iron gall",
  "parchment",
  "bond",
  "graphite",
  "bone",
  "hi-contrast dark",
  "hi-contrast light"
];

export interface QuotaLedger {
  /** Local calendar day the count belongs to, YYYY-MM-DD. */
  date: string;
  words: number;
}

export interface UpdatePreferences {
  mode: "off" | "notify";
  channel: "stable" | "beta";
  skippedVersion: string | null;
}

/** Which rows the Settings panel shows: `simple` lists only the most-used
 *  rows, `advanced` shows every row. A view preference, not a setting, so it
 *  lives here beside `factsRail` rather than in the server-backed settings
 *  document (see settings-local-rows.ts). */
export type SettingsViewMode = "simple" | "advanced";

export interface UserConfig {
  /** Version of the persisted user-config document. */
  schemaVersion: 1;
  theme: ThemeName;
  factsRail: "auto" | "off";
  composeFocus: "on" | "off";
  /** Whether Aside thought text is visible while reading or chatting. */
  asideThoughts: "show" | "hide";
  /** Break editor lines at word boundaries instead of clipping them. Every
   *  composer-backed surface reads this: Direct, the document editors, and the
   *  Fact body. */
  wordWrap: "on" | "off";
  /** Null follows max(6, floor(terminal rows / 3)). */
  composeMaxHeight: number | null;
  quota: QuotaLedger;
  updates: UpdatePreferences;
  /** The product version of the last interactive run. Null before the first run. */
  lastRunVersion: string | null;
  /** Which rows the Settings panel shows. `m` flips it for the rest of the
   *  session and persists the choice here, the same way compose focus and
   *  word wrap persist (settings-selector-actions.ts). */
  settingsViewMode: SettingsViewMode;
}

const DEFAULTS: UserConfig = {
  schemaVersion: 1,
  // Keep this legacy fallback for an existing config without a theme. A new
  // install gets `NEW_INSTALL_THEME` when `loadConfigWithStatus` finds no file.
  theme: "lantern",
  factsRail: "auto",
  composeFocus: "off",
  asideThoughts: "hide",
  wordWrap: "on",
  composeMaxHeight: null,
  quota: { date: "", words: 0 },
  updates: { mode: "notify", channel: "stable", skippedVersion: null },
  lastRunVersion: null,
  settingsViewMode: "simple"
};

type ConfigRecord = Record<string, unknown>;

function record(value: unknown): ConfigRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as ConfigRecord
    : {};
}

function configValue(raw: ConfigRecord, canonical: string, legacy: string): unknown {
  return Object.hasOwn(raw, canonical) ? raw[canonical] : raw[legacy];
}

function normalizedComposeFocus(value: unknown): UserConfig["composeFocus"] {
  return value === true || value === "on" ? "on" : "off";
}

function normalizedAsideThoughts(value: unknown): UserConfig["asideThoughts"] {
  return value === "show" ? "show" : "hide";
}

/** Absent means on, so an existing config file keeps wrapping the editors. */
function normalizedWordWrap(value: unknown): UserConfig["wordWrap"] {
  return value === false || value === "off" ? "off" : "on";
}

function normalizedComposeMaxHeight(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return null;
  return Math.floor(value);
}

/**
 * Upgrade and sanitize user-edited config without making startup brittle.
 * Snake-case aliases keep the documented config keys usable while persistence
 * remains consistent with the existing camel-case JSON format.
 */
export function normalizeUserConfig(value: unknown): UserConfig {
  const raw = record(value);
  const rawQuota = record(raw.quota);
  const rawUpdates = record(raw.updates);
  const theme = raw.theme;
  const factsRail = configValue(raw, "factsRail", "facts_rail");
  const composeFocus = configValue(raw, "composeFocus", "compose_focus");
  const asideThoughts = configValue(raw, "asideThoughts", "aside_thoughts");
  const wordWrap = configValue(raw, "wordWrap", "word_wrap");
  const composeMaxHeight = configValue(raw, "composeMaxHeight", "compose_max_height");
  const settingsViewMode = configValue(raw, "settingsViewMode", "settings_view_mode");
  const quotaValid = typeof rawQuota.date === "string"
    && typeof rawQuota.words === "number"
    && Number.isFinite(rawQuota.words);
  return {
    schemaVersion: 1,
    theme: THEME_NAMES.includes(theme as ThemeName) ? theme as ThemeName : DEFAULTS.theme,
    factsRail: factsRail === "off" ? "off" : "auto",
    composeFocus: normalizedComposeFocus(composeFocus),
    asideThoughts: normalizedAsideThoughts(asideThoughts),
    wordWrap: normalizedWordWrap(wordWrap),
    composeMaxHeight: normalizedComposeMaxHeight(composeMaxHeight),
    settingsViewMode: settingsViewMode === "advanced" ? "advanced" : "simple",
    quota: quotaValid
      ? { date: rawQuota.date as string, words: rawQuota.words as number }
      : { ...DEFAULTS.quota },
    updates: {
      // The old schema persisted "off" as its default. It cannot distinguish
      // that value from an opt-out, so migrate it to the new default. Schema 1
      // marks choices made after the Settings control became available.
      mode: raw.schemaVersion === 1 && rawUpdates.mode === "off"
        ? "off"
        : "notify",
      channel: rawUpdates.channel === "beta" ? "beta" : "stable",
      skippedVersion: isSemVer(rawUpdates.skippedVersion)
        ? rawUpdates.skippedVersion
        : null
    },
    lastRunVersion: isSemVer(raw.lastRunVersion) ? raw.lastRunVersion : null
  };
}

function configPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "1667", "config.json");
}

export interface ConfigPersistenceOptions {
  readonly file?: string;
  /** Crash-injection seam after durable temp contents, before replacement. */
  readonly afterTemporaryFileSync?: (temporaryFile: string) => void;
}

/**
 * `absent`: no file at that path (`ENOENT`) — a genuinely new install.
 * `unreadable`: a file is there, but could not be read or did not parse —
 * a config a caller must never overwrite, since it may be the only copy of
 * the writer's settings and it may still be repairable by hand.
 * `loaded`: the file parsed. Its content may still be old or partial;
 * `normalizeUserConfig` already covers that.
 */
export type ConfigLoadStatus = "absent" | "loaded" | "unreadable";

/** Load the config file and say which of the three outcomes happened, so a
 *  caller that must not clobber an unreadable file can tell it apart from a
 *  fresh install — `loadConfig` alone collapses both to the same defaults. */
export function loadConfigWithStatus(
  options: ConfigPersistenceOptions = {}
): { readonly status: ConfigLoadStatus; readonly config: UserConfig } {
  const file = options.file ?? configPath();
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    const status = isEnoent(error) ? "absent" : "unreadable";
    const config = normalizeUserConfig(null);
    return {
      status,
      config: status === "absent" ? { ...config, theme: NEW_INSTALL_THEME } : config
    };
  }
  try {
    return { status: "loaded", config: normalizeUserConfig(JSON.parse(raw)) };
  } catch {
    return { status: "unreadable", config: normalizeUserConfig(null) };
  }
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && (error as { code?: unknown }).code === "ENOENT";
}

export function loadConfig(
  options: ConfigPersistenceOptions = {}
): UserConfig {
  return loadConfigWithStatus(options).config;
}

/** Persist a config, and say whether it actually landed. A read-only or full
 *  home must not break the app, so a write failure here is swallowed rather
 *  than thrown — but a caller for whom persistence is the whole point (see
 *  `announceRelease`) needs to tell that apart from success, or it acts on a
 *  promise the disk never kept. Existing callers that ignore the result keep
 *  working unchanged. */
export function saveConfig(
  config: UserConfig,
  options: ConfigPersistenceOptions = {}
): boolean {
  let temporaryFile: string | null = null;
  try {
    const file = options.file ?? configPath();
    const directory = dirname(file);
    mkdirSync(directory, { recursive: true });
    temporaryFile = `${file}.${process.pid}.`
      + `${randomBytes(8).toString("hex")}.tmp`;
    let temporaryDescriptor: number | null = null;
    try {
      temporaryDescriptor = openSync(
        temporaryFile,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600
      );
      writeFileSync(
        temporaryDescriptor,
        `${JSON.stringify(normalizeUserConfig(config), null, 2)}\n`,
        "utf8"
      );
      fsyncSync(temporaryDescriptor);
    } finally {
      if (temporaryDescriptor !== null) closeSync(temporaryDescriptor);
    }
    options.afterTemporaryFileSync?.(temporaryFile);
    renameSync(temporaryFile, file);
    temporaryFile = null;
    syncConfigDirectory(directory);
    return true;
  } catch {
    // A read-only/full home must not break the app or truncate the last config.
    return false;
  } finally {
    if (temporaryFile !== null) {
      try {
        unlinkSync(temporaryFile);
      } catch {
        // The incomplete sibling is non-authoritative.
      }
    }
  }
}

function syncConfigDirectory(directory: string): void {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      directory,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0)
    );
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function localDay(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/** Add human-written words to today's ledger, rolling the day when it turns. */
export function recordHumanWords(config: UserConfig, words: number, now = new Date()): UserConfig {
  if (words <= 0) return config;
  const today = localDay(now);
  const base = config.quota.date === today ? config.quota.words : 0;
  const next = { ...config, quota: { date: today, words: base + words } };
  saveConfig(next);
  return next;
}

export function quotaToday(config: UserConfig, now = new Date()): number {
  return config.quota.date === localDay(now) ? config.quota.words : 0;
}
