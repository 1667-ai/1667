import { privatePublicationScratchPath } from "./private-file-publication.js";

export type DataDirectoryFormat = 1 | 2;

/**
 * ADR007 project-tier names. The product prefix these once carried existed to
 * disambiguate 1667's files inside a directory it did not own; inside `.1667/`
 * it owns everything.
 */
export const DATA_DIRECTORY_LOCK = "lock";
export const DATA_DIRECTORY_OWNER_MARKER = "owner.json";
export const DATA_DIRECTORY_OWNER_MARKER_NEXT = "owner.json.next";
/** Advisory record of the process serving this project. Never authoritative. */
export const PROJECT_RUN_RECORD_FILE = "run.json";

/**
 * Names written by builds before ADR007. Nothing creates them; `1667 init
 * --adopt` reads them, and a legacy source migration excludes them.
 */
export const LEGACY_DATA_OWNER_MARKER = ".1667-data-owner.json";
export const LEGACY_DATA_OWNER_MARKER_NEXT = ".1667-data-owner.json.next";
export const LEGACY_EXCLUSION_FENCE = ".1667.lock";
export const LEGACY_PROCESS_OWNER_LOCK = ".1667.owner-v1";
export const LEGACY_HARDENED_PROCESS_LOCK = ".1667-data.lock";
export const LEGACY_PREVIEW_DATA_MARKER = ".1667-data-v1.json";

export const SETTINGS_STATE_V1_FILE = "settings.json";
export const SETTINGS_STATE_V1_NEXT_FILE = "settings.json.next";
export const SETTINGS_STATE_V2_FILE = "settings.v2.state.json";
export const SETTINGS_STATE_V2_NEXT_FILE = "settings.v2.state.json.next";
export const PROVIDER_SECRETS_FILE = "secrets.json";
export const PROVIDER_SECRETS_NEXT_FILE = "secrets.json.next";
export const DATA_DIRECTORY_OWNER_MARKER_NEXT_SCRATCH =
  privatePublicationScratchPath(DATA_DIRECTORY_OWNER_MARKER_NEXT);
export const SETTINGS_STATE_V2_NEXT_SCRATCH =
  privatePublicationScratchPath(SETTINGS_STATE_V2_NEXT_FILE);
export const PROVIDER_SECRETS_NEXT_SCRATCH =
  privatePublicationScratchPath(PROVIDER_SECRETS_NEXT_FILE);
export const LEGACY_PREVIEW_DATA_MARKER_TEXT =
  '{"format":"1667-lock-aware-data","version":1}\n';

/** Control/residue entries never copied from a legacy source migration. */
export const DATA_DIRECTORY_MIGRATION_EXCLUDED_ENTRY_NAMES = Object.freeze([
  DATA_DIRECTORY_LOCK,
  DATA_DIRECTORY_OWNER_MARKER,
  DATA_DIRECTORY_OWNER_MARKER_NEXT,
  DATA_DIRECTORY_OWNER_MARKER_NEXT_SCRATCH,
  PROJECT_RUN_RECORD_FILE,
  LEGACY_DATA_OWNER_MARKER,
  LEGACY_DATA_OWNER_MARKER_NEXT,
  LEGACY_EXCLUSION_FENCE,
  LEGACY_PROCESS_OWNER_LOCK,
  LEGACY_HARDENED_PROCESS_LOCK,
  LEGACY_PREVIEW_DATA_MARKER,
  SETTINGS_STATE_V2_FILE,
  SETTINGS_STATE_V2_NEXT_FILE,
  SETTINGS_STATE_V2_NEXT_SCRATCH,
  PROVIDER_SECRETS_FILE,
  PROVIDER_SECRETS_NEXT_FILE,
  PROVIDER_SECRETS_NEXT_SCRATCH
] as const);
