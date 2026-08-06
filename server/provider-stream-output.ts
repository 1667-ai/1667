import type { GenerationSettings } from "../shared/types.js";
import { ProviderError } from "./errors.js";
import { redactProviderSecrets } from "./provider-runtime.js";

const MAX_DECODED_OUTPUT_BYTES = 16 * 1024 * 1024;

export function providerOutputByteLimit(settings: GenerationSettings): number {
  return Math.min(
    MAX_DECODED_OUTPUT_BYTES,
    settings.maxTokens * 32 + 64 * 1024
  );
}

export function parseProviderStreamEvent(
  data: string,
  secrets: readonly string[]
): Record<string, unknown> {
  try {
    const parsed = JSON.parse(data) as unknown;
    return isProviderObject(parsed) ? parsed : {};
  } catch {
    const detail = redactProviderSecrets(data, secrets).slice(0, 200);
    throw new ProviderError(`Model sent a non-JSON stream event: ${detail}`);
  }
}

export function requireProviderOutputWithinLimit(
  settings: GenerationSettings,
  currentBytes: number,
  delta: string
): number {
  const next = currentBytes + Buffer.byteLength(delta);
  const tokenDerived = providerOutputByteLimit(settings);
  if (next > tokenDerived) {
    throw new ProviderError(
      "provider_response_too_large: decoded model output exceeded its safety limit."
    );
  }
  return next;
}

export function isProviderObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
