import { release } from "node:os";
import { PublicRuntimeError } from "./errors.js";

const MINIMUM_LINUX_HTTP_KERNEL = [6, 8] as const;

export function assertHttpPlatformSupport(
  platform: NodeJS.Platform = process.platform,
  kernelRelease: string = release()
): void {
  if (platform !== "linux") {
    throw new PublicRuntimeError(
      "HTTP server mode requires Linux retained-directory authority"
    );
  }
  const observed = linuxKernelVersion(kernelRelease);
  if (observed === null
    || compareNumericVersion(observed, MINIMUM_LINUX_HTTP_KERNEL) < 0) {
    throw new PublicRuntimeError(
      "Linux HTTP mode requires Linux kernel 6.8 or later"
    );
  }
}

export function linuxKernelVersion(
  kernelRelease: string
): readonly number[] | null {
  const prefix = /^([0-9]+(?:\.[0-9]+)+)/u.exec(
    kernelRelease.trim()
  )?.[1];
  return prefix === undefined ? null : prefix.split(".").map(Number);
}

function compareNumericVersion(
  observed: readonly number[],
  minimum: readonly number[]
): number {
  const length = Math.max(observed.length, minimum.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (observed[index] ?? 0) - (minimum[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}
