import { ServiceError } from "./errors.js";

export function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new ServiceError(400, `Missing ${label}`);
  return value;
}

export function requireStringValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new ServiceError(400, `${label} must be a string`);
  return value;
}

export function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function requireRecord(value: unknown, label = "input"): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ServiceError(400, `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

/** JSON drops object properties whose value is undefined. Treat structured-clone
 * worker inputs the same way at every presence-sensitive service boundary. */
export function hasDefinedProperty(value: object, key: string): boolean {
  return Object.hasOwn(value, key) && (value as Record<string, unknown>)[key] !== undefined;
}
