import {
  MAX_CREDENTIAL_NAMES_PER_STATE,
  isCredentialEnvironmentName
} from "./credential-slot-policy.js";

export const SUPERVISED_SECRET_CHANNEL_MAX_BYTES = 256 * 1024;
const MAX_SECRET_VALUE_BYTES = 16 * 1024;

export function encodeSupervisedSecrets(
  values: Readonly<Record<string, string | null>>
): Buffer {
  validateSecrets(values);
  const bytes = Buffer.from(`${JSON.stringify(values)}\n`, "utf8");
  if (bytes.byteLength > SUPERVISED_SECRET_CHANNEL_MAX_BYTES) {
    bytes.fill(0);
    throw new Error("Supervised secret payload is too large");
  }
  return bytes;
}

export function decodeSupervisedSecrets(
  bytes: Uint8Array
): Readonly<Record<string, string | null>> {
  if (bytes.byteLength === 0
    || bytes.byteLength > SUPERVISED_SECRET_CHANNEL_MAX_BYTES) {
    throw new Error("Supervised secret payload has an invalid size");
  }
  const buffer = Buffer.from(bytes);
  try {
    const text = buffer.toString("utf8");
    if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) {
      throw new Error("Supervised secret payload is not one canonical frame");
    }
    const value: unknown = JSON.parse(text.slice(0, -1));
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Supervised secret payload is not an object");
    }
    const record = value as Record<string, unknown>;
    validateSecrets(record);
    if (`${JSON.stringify(record)}\n` !== text) {
      throw new Error("Supervised secret payload is not canonical JSON");
    }
    return record as Readonly<Record<string, string | null>>;
  } finally {
    buffer.fill(0);
  }
}

function validateSecrets(values: Readonly<Record<string, unknown>>): void {
  const names = Object.keys(values);
  if (names.length > MAX_CREDENTIAL_NAMES_PER_STATE
    || names.some((name) => !isCredentialEnvironmentName(name))
    || names.some((name, index) => index > 0 && names[index - 1]! >= name)) {
    throw new Error("Supervised secret payload has invalid credential slots");
  }
  for (const value of Object.values(values)) {
    if (value !== null && typeof value !== "string") {
      throw new Error("Supervised secret payload has an invalid value");
    }
    if (typeof value === "string"
      && Buffer.byteLength(value, "utf8") > MAX_SECRET_VALUE_BYTES) {
      throw new Error("Supervised secret value is too large");
    }
  }
}
