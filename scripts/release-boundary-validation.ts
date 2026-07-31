import path from "node:path";

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Windows decides executability by extension, not by mode. NTFS exposes no
 * POSIX execute bits through Node, so a mode test there rejects every real
 * executable, and dropping the test there instead accepts every regular file.
 * One rule, keyed on the host that runs the check.
 */
const WINDOWS_EXECUTABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".exe",
  ".com"
]);

export function isExecutableFile(file: string, mode: number): boolean {
  if (process.platform === "win32") {
    return WINDOWS_EXECUTABLE_EXTENSIONS.has(path.extname(file).toLowerCase());
  }
  return (mode & 0o111) !== 0;
}

export function exactRecord(
  value: unknown,
  expectedKeys: ReadonlySet<string>,
  label: string
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== expectedKeys.size || keys.some((key) => !expectedKeys.has(key))) {
    throw new Error(`${label} has unknown or missing fields`);
  }
  return record;
}

export function sha256Digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} has an invalid SHA-256 digest`);
  }
  return value;
}
