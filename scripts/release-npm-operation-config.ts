import type { NpmOperationDeadlineOptions } from
  "./release-npm-operation-deadline.js";

export interface GitHubNpmOperationLeaseOptions
  extends NpmOperationDeadlineOptions {
  readonly repository: string;
  readonly token: string;
  readonly apiUrl?: string;
  readonly fetch?: typeof fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly pollIntervalMs?: number;
  readonly maxPolls?: number;
  readonly maxUnclaimedPolls?: number;
  readonly serverTime?: () => Promise<number>;
  readonly verifyControls?: () => Promise<void>;
}

export function positiveInteger(
  value: number,
  maximum: number,
  label: string
): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

export async function currentTime(
  serverTime: () => Promise<number>
): Promise<number> {
  const value = await serverTime();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("npm operation lease current time is invalid");
  }
  return value;
}
