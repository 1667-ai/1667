const SHA256 = /^[0-9a-f]{64}$/;

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
