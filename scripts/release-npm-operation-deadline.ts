const DEFAULT_UNCLAIMED_TIMEOUT_MS = 55_000;

export interface NpmOperationDeadlineOptions {
  readonly lockStartedAtMs?: number;
  readonly unclaimedTimeoutMs?: number;
  readonly now?: () => number;
}

export class NpmOperationUnclaimedDeadline {
  readonly #deadline: number;
  readonly #now: () => number;
  readonly startedAt: number;
  readonly signal: AbortSignal;

  constructor(options: NpmOperationDeadlineOptions) {
    this.#now = options.now ?? Date.now;
    const startedAt = time(options.lockStartedAtMs ?? this.#now(), "lock start");
    this.startedAt = startedAt;
    const timeout = positiveInteger(
      options.unclaimedTimeoutMs ?? DEFAULT_UNCLAIMED_TIMEOUT_MS,
      DEFAULT_UNCLAIMED_TIMEOUT_MS
    );
    this.#deadline = time(startedAt + timeout, "unclaimed deadline");
    const remaining = this.#deadline - this.#now();
    this.signal = remaining <= 0
      ? AbortSignal.abort()
      : AbortSignal.timeout(remaining);
  }

  requireTime(): void {
    if (this.#now() >= this.#deadline || this.signal.aborted) {
      throw new Error("npm operation lease was not claimed before its deadline");
    }
  }

  boundedInterval(milliseconds: number): number {
    this.requireTime();
    return Math.min(milliseconds, this.#deadline - this.#now());
  }
}

export function serverAnchoredNpmOperationDeadline(
  options: NpmOperationDeadlineOptions,
  acquisition: GitHubConcurrencyAcquisition,
  fallbackStartedAt?: number
): NpmOperationUnclaimedDeadline {
  const now = (options.now ?? Date.now)();
  const serverAge = acquisition.observedAt - acquisition.acquiredAt + 999;
  if (!Number.isSafeInteger(now) || now < 0
    || !Number.isSafeInteger(serverAge) || serverAge < 0
    || serverAge > now) {
    throw new Error("npm operation lease concurrency acquisition time is invalid");
  }
  const serverStartOnRunner = now - serverAge;
  const localStart = fallbackStartedAt ?? options.lockStartedAtMs ?? now;
  return new NpmOperationUnclaimedDeadline({
    ...options,
    lockStartedAtMs: Math.min(localStart, serverStartOnRunner)
  });
}

function time(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`npm operation lease ${label} is invalid`);
  }
  return value;
}

function positiveInteger(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error("npm operation lease unclaimed timeout is invalid");
  }
  return value;
}
import type { GitHubConcurrencyAcquisition } from
  "./release-github-concurrency.js";
