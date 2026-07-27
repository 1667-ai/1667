import { unlink } from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "./canonical-json.js";
import { PROJECT_RUN_RECORD_FILE } from "./data-directory-layout.js";
import { readBoundedRegularFile } from "./data-directory-file-read.js";
import { writeDurableAtomic } from "./story-lifecycle.js";
import { parseJsonRejectingDuplicateKeys } from "./strict-json.js";

const MAX_RUN_RECORD_BYTES = 4 * 1024;

/**
 * The kernel lock is the only authority on whether a project is open.
 * `run.json` is the one stale-prone artifact and is purely advisory — startup
 * never refuses on it, and every reader tolerates a record left by a process
 * that died.
 */
export interface ProjectRunRecord {
  readonly pid: number;
  readonly port: number | null;
  readonly url: string | null;
  readonly startedAt: string;
}

export function projectRunRecordPath(projectDir: string): string {
  return path.join(projectDir, PROJECT_RUN_RECORD_FILE);
}

/** Never throws: an absent, unreadable, or malformed record is simply absent. */
export async function readProjectRunRecord(
  projectDir: string
): Promise<ProjectRunRecord | null> {
  try {
    const bytes = await readBoundedRegularFile(
      projectRunRecordPath(projectDir),
      MAX_RUN_RECORD_BYTES
    );
    return parseRunRecord(bytes.toString("utf8"));
  } catch {
    return null;
  }
}

export async function publishProjectRunRecord(
  projectDir: string,
  record: ProjectRunRecord
): Promise<void> {
  await writeDurableAtomic(
    projectRunRecordPath(projectDir),
    `${canonicalJson(record)}\n`
  );
}

export async function removeProjectRunRecord(projectDir: string): Promise<void> {
  await unlink(projectRunRecordPath(projectDir)).catch(() => undefined);
}

function parseRunRecord(text: string): ProjectRunRecord | null {
  const value = parseJsonRejectingDuplicateKeys(text, "Project run record");
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const pid = record.pid;
  const port = record.port ?? null;
  const url = record.url ?? null;
  const startedAt = record.startedAt;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return null;
  if (port !== null && (typeof port !== "number" || !Number.isSafeInteger(port))) return null;
  if (url !== null && typeof url !== "string") return null;
  if (typeof startedAt !== "string") return null;
  return { pid, port, url, startedAt };
}
