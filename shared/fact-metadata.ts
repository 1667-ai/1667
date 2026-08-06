import { hasUnpairedSurrogate, unicodeScalarLength } from "./unicode.js";

export const FACT_ACTIVATIONS = ["always", "keyed"] as const;
export type FactActivation = (typeof FACT_ACTIVATIONS)[number];
export const FACT_PRIORITIES = ["low", "normal", "high"] as const;
export type FactPriority = (typeof FACT_PRIORITIES)[number];
export const FACT_SECONDARY_MODES = ["and", "not"] as const;
export type FactSecondaryMode = (typeof FACT_SECONDARY_MODES)[number];
export const FACT_RECURSIONS = ["on", "off"] as const;
export type FactRecursion = (typeof FACT_RECURSIONS)[number];

export const MAX_FACT_KEYS = 32;
export const MAX_FACT_SECONDARY_KEYS = MAX_FACT_KEYS;
export const MAX_FACT_KEY_SCALARS = 64;
export const DEFAULT_FACT_SCAN_PARTS = 3;
export const MAX_FACT_SCAN_PARTS = 20;
export const MAX_FACT_SCAN_UTF16 = 20_000;
export const MAX_FACT_RECURSION_UTF16 = 20_000;
export const MAX_FACT_RECURSION_ROUNDS = 3;
export const MAX_FACT_PATTERN_STEPS = 1_000_000;

export class FactActivationError extends Error {
  constructor(message: string) { super(message); this.name = "FactActivationError"; }
}

export function parseFactActivation(value: unknown, label = "Fact activation"): FactActivation {
  if (!FACT_ACTIVATIONS.includes(value as FactActivation)) {
    throw new FactActivationError(`${label} must be "always" or "keyed"`);
  }
  return value as FactActivation;
}
export function parseFactPriority(value: unknown, label = "Fact priority"): FactPriority {
  if (!FACT_PRIORITIES.includes(value as FactPriority)) {
    throw new FactActivationError(`${label} must be "low", "normal", or "high"`);
  }
  return value as FactPriority;
}
export function parseFactSecondaryMode(value: unknown, label = "Fact secondaryMode"): FactSecondaryMode {
  if (!FACT_SECONDARY_MODES.includes(value as FactSecondaryMode)) {
    throw new FactActivationError(`${label} must be "and" or "not"`);
  }
  return value as FactSecondaryMode;
}
export function parseFactRecursion(value: unknown, label = "Fact recursion"): FactRecursion {
  if (!FACT_RECURSIONS.includes(value as FactRecursion)) {
    throw new FactActivationError(`${label} must be "on" or "off"`);
  }
  return value as FactRecursion;
}
export function parseFactScanDepth(value: unknown, label = "Fact scanDepth"): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_FACT_SCAN_PARTS) {
    throw new FactActivationError(`${label} must be an integer from 1 to ${MAX_FACT_SCAN_PARTS}`);
  }
  return value as number;
}
export function assertFactKeyText(value: string, label: string): void {
  if (value.length === 0 || value.trim().length === 0) throw new FactActivationError(`${label} must not be empty`);
  if (/[\r\n\u2028\u2029]/u.test(value)) throw new FactActivationError(`${label} must be a single line`);
  if (hasUnpairedSurrogate(value)) throw new FactActivationError(`${label} contains invalid Unicode`);
  if (unicodeScalarLength(value, MAX_FACT_KEY_SCALARS + 1) > MAX_FACT_KEY_SCALARS) {
    throw new FactActivationError(`${label} exceeds the ${MAX_FACT_KEY_SCALARS}-character limit`);
  }
}
