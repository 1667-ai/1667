import path from "node:path";
import {
  DATA_DIRECTORY_ID_FILE,
  DATA_DIRECTORY_ID_SCRATCH,
  DATA_DIRECTORY_LOCK,
  HTTP_DATA_DIRECTORY_CLAIM_KEY_ENTRY_NAMES,
  PROJECT_RUN_RECORD_FILE,
  PROVIDER_SECRET_ENTRY_NAMES
} from "./data-directory-layout.js";

/** 1667 finds its stories the way git finds its objects. */
export const PROJECT_DIRECTORY_NAME = ".1667";
export const PROJECT_GITIGNORE_FILE = ".gitignore";
export const DATA_DIRECTORY_ID_GITIGNORE_BLOCK =
  `# 1667 durable project lineage\n!${DATA_DIRECTORY_ID_FILE}\n${
    DATA_DIRECTORY_ID_SCRATCH
  }\n# 1667 machine-local HTTP claim\n${
    HTTP_DATA_DIRECTORY_CLAIM_KEY_ENTRY_NAMES.join("\n")
  }\n`;

export function projectDirectory(projectRoot: string): string {
  return path.join(projectRoot, PROJECT_DIRECTORY_NAME);
}

/**
 * Names 1667 owns inside a project tier that must never travel with it: a
 * plaintext key, a lock that means nothing on another machine, and a record of
 * a process that is not running there. Derived from the layout constants so a
 * rename cannot leave this list behind.
 */
export function projectGitignoreContent(): string {
  const ignored = [
    ...PROVIDER_SECRET_ENTRY_NAMES,
    DATA_DIRECTORY_LOCK,
    PROJECT_RUN_RECORD_FILE
  ];
  return `${[...new Set(ignored)].sort().join("\n")}\n${
    DATA_DIRECTORY_ID_GITIGNORE_BLOCK
  }`;
}
