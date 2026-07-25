import { ServiceError } from "./errors.js";

/**
 * ADR007: the kernel lock is the only authority on whether a project is open,
 * so contention names the holder when a run record says who it is and never
 * offers to break the lock.
 */
export function lockedDataDirectoryError(
  holder: { readonly pid: number } | null
): ServiceError {
  const held = holder === null
    ? "another 1667 process"
    : `1667 process ${holder.pid}`;
  return new ServiceError(
    409,
    `This 1667 project is already open by ${held}. Stop it and retry, `
      + "attach to it with 1667 --url, or open a different project with "
      + "1667 --data <project-root>."
  );
}
