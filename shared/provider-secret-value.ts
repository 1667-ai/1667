export const MAX_PROVIDER_SECRET_VALUE_BYTES = 16 * 1024;

const UTF8_ENCODER = new TextEncoder();

export function validateProviderSecretValue(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Stored API key must be a non-empty string");
  }
  if (UTF8_ENCODER.encode(value).byteLength > MAX_PROVIDER_SECRET_VALUE_BYTES) {
    throw new Error(
      `Stored API key exceeds the ${MAX_PROVIDER_SECRET_VALUE_BYTES}-byte limit`
    );
  }
  if (/^[\t ]|[\t ]$/u.test(value)) {
    throw new Error("Stored API key contains surrounding HTTP whitespace");
  }
  return value;
}
