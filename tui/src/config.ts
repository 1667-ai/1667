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
import {
  normalizeReadingPositions,
  type ReadingPositions
} from "./reading-position.js";

export type ThemeName =
  | "lantern"
  | "iron gall"
  | "parchment"
  | "bond"
  | "hi-contrast dark"
  | "hi-contrast light";

export const THEME_NAMES: readonly ThemeName[] = [
  "lantern",
  "iron gall",
  "parchment",
  "bond",
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

export interface UserConfig {
  theme: ThemeName;
  factsRail: "auto" | "off";
  composeFocus: "on" | "off";
  /** Null follows max(6, floor(terminal rows / 3)). */
  composeMaxHeight: number | null;
  quota: QuotaLedger;
  updates: UpdatePreferences;
  /** Local last-focused part per story. Soft UI state; not manuscript content. */
  readingPositions: ReadingPositions;
}

const DEFAULTS: UserConfig = {
  theme: "lantern",
  factsRail: "auto",
  composeFocus: "off",
  composeMaxHeight: null,
  quota: { date: "", words: 0 },
  updates: { mode: "off", channel: "stable", skippedVersion: null },
  readingPositions: {}
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
  const composeMaxHeight = configValue(raw, "composeMaxHeight", "compose_max_height");
  const quotaValid = typeof rawQuota.date === "string"
    && typeof rawQuota.words === "number"
    && Number.isFinite(rawQuota.words);
  return {
    theme: THEME_NAMES.includes(theme as ThemeName) ? theme as ThemeName : DEFAULTS.theme,
    factsRail: factsRail === "off" ? "off" : "auto",
    composeFocus: normalizedComposeFocus(composeFocus),
    composeMaxHeight: normalizedComposeMaxHeight(composeMaxHeight),
    quota: quotaValid
      ? { date: rawQuota.date as string, words: rawQuota.words as number }
      : { ...DEFAULTS.quota },
    updates: {
      mode: rawUpdates.mode === "notify" ? "notify" : "off",
      channel: rawUpdates.channel === "beta" ? "beta" : "stable",
      skippedVersion: isSemVer(rawUpdates.skippedVersion)
        ? rawUpdates.skippedVersion
        : null
    },
    readingPositions: normalizeReadingPositions(
      configValue(raw, "readingPositions", "reading_positions")
    )
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

export function loadConfig(
  options: ConfigPersistenceOptions = {}
): UserConfig {
  try {
    return normalizeUserConfig(JSON.parse(
      readFileSync(options.file ?? configPath(), "utf8")
    ));
  } catch {
    return normalizeUserConfig(null);
  }
}

export function saveConfig(
  config: UserConfig,
  options: ConfigPersistenceOptions = {}
): void {
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
  } catch {
    // A read-only/full home must not break the app or truncate the last config.
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
