import { privatePublicationScratchPath } from "./private-file-publication.js";

export type DataDirectoryFormat = 1 | 2;

/**
 * Project-tier names. The product prefix these once carried existed to
 * disambiguate 1667's files inside a directory it did not own; inside `.1667/`
 * it owns everything.
 */
export const DATA_DIRECTORY_LOCK = "lock";
export const DATA_DIRECTORY_OWNER_MARKER = "owner.json";
export const DATA_DIRECTORY_OWNER_MARKER_NEXT = "owner.json.next";
/** Advisory record of the process serving this project. Never authoritative. */
export const PROJECT_RUN_RECORD_FILE = "run.json";

/**
 * Names written by older builds. Nothing creates them; `1667 init
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
/** Serializes read-modify-write publication of the machine-wide secrets file. */
export const PROVIDER_SECRETS_LOCK_FILE = "secrets.lock";
export const DATA_DIRECTORY_OWNER_MARKER_NEXT_SCRATCH =
  privatePublicationScratchPath(DATA_DIRECTORY_OWNER_MARKER_NEXT);
export const SETTINGS_STATE_V2_NEXT_SCRATCH =
  privatePublicationScratchPath(SETTINGS_STATE_V2_NEXT_FILE);
export const PROVIDER_SECRETS_NEXT_SCRATCH =
  privatePublicationScratchPath(PROVIDER_SECRETS_NEXT_FILE);
export const LEGACY_PREVIEW_DATA_MARKER_TEXT =
  '{"format":"1667-lock-aware-data","version":1}\n';

/**
 * Entries 1667 owns as control state rather than as the user's writing, in
 * both current and legacy names. Provider secrets belong here because they
 * live in the machine tier now, never beside the stories.
 */
/**
 * Names that can hold a plaintext key. The project-tier fence refuses these,
 * because one of them inside a folder the user may commit is the loss that
 * fence exists to prevent.
 */
export const PROVIDER_SECRET_VALUE_ENTRY_NAMES = Object.freeze([
  PROVIDER_SECRETS_FILE,
  PROVIDER_SECRETS_NEXT_FILE,
  PROVIDER_SECRETS_NEXT_SCRATCH
] as const);

/**
 * Every name the machine-tier secret store owns, including the empty lock file,
 * which carries no key and so is ignored rather than refused. Defined once so
 * the `.gitignore` and the control-entry list cannot drift from each other.
 */
export const PROVIDER_SECRET_ENTRY_NAMES = Object.freeze([
  ...PROVIDER_SECRET_VALUE_ENTRY_NAMES,
  PROVIDER_SECRETS_LOCK_FILE
] as const);

export const PROJECT_CONTROL_ENTRY_NAMES = Object.freeze([
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
  ...PROVIDER_SECRET_ENTRY_NAMES
] as const);

/**
 * Also excluded when copying a legacy v1 source: format-2 settings state
 * belongs to the generation of the directory that wrote it, and a v1 migration
 * initializes its own. Adoption instead carries the settings across, which is
 * why it excludes only PROJECT_CONTROL_ENTRY_NAMES.
 */
export const DATA_DIRECTORY_MIGRATION_EXCLUDED_ENTRY_NAMES = Object.freeze([
  ...PROJECT_CONTROL_ENTRY_NAMES,
  SETTINGS_STATE_V2_FILE,
  SETTINGS_STATE_V2_NEXT_FILE,
  SETTINGS_STATE_V2_NEXT_SCRATCH
] as const);
