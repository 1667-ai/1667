/**
 * The process-wide image stage permit.
 *
 * At most one image is staging or releasing at a time; at most two more
 * callers wait behind it; a fourth caller is refused immediately with
 * `image_stage_busy`. Both the HTTP transport (server/http-router.ts) and
 * the embedded worker transport (server/worker-request-executor.ts) import
 * this exact module, so both contend on the same in-process state: Node
 * caches a module by its resolved path, and both transports run inside the
 * one process that hosts `StoryService`.
 *
 * The caller decides when to acquire: the HTTP route acquires before it
 * reads the request body, and holds the permit through normalization and
 * publication, releasing on every terminal path, success, a thrown error,
 * a caller disconnect, or the operation deadline, because every one of
 * those releases through the same `finally` block around the acquired
 * permit. A waiter removes itself the same way: its wait promise rejects the
 * moment its `AbortSignal` fires, whether that is a disconnect, a
 * cancellation, or a deadline, so a caller that gives up while waiting never
 * occupies a waiter slot after it stops caring about the result.
 */
import { ServiceError } from "./errors.js";
import { IMAGE_STAGE_WAITER_LIMIT } from "../shared/image-attachment.js";

interface Waiter {
  readonly grant: () => void;
}

let active = false;
const waiters: Waiter[] = [];

/**
 * Reserve the permit, or throw `image_stage_busy` immediately when it is
 * already held and two callers are already waiting. Call this before
 * reading any request body or Draft Image bytes, so a refusal never costs
 * the caller anything it already read.
 *
 * Returns a release function. The caller must call it exactly once, on
 * every terminal path, a `finally` block is the natural place.
 */
export async function acquireImageStagePermit(
  signal?: AbortSignal
): Promise<() => void> {
  if (signal?.aborted === true) throw abortError(signal);
  if (!active) {
    active = true;
    return release;
  }
  if (waiters.length >= IMAGE_STAGE_WAITER_LIMIT) {
    throw new ServiceError(
      429,
      "Another image is already staging, and two more are already waiting.",
      "image_stage_busy"
    );
  }
  return await new Promise<() => void>((resolve, reject) => {
    let settled = false;
    const waiter: Waiter = {
      grant: () => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        resolve(release);
      }
    };
    const onAbort = () => {
      if (settled) return;
      const index = waiters.indexOf(waiter);
      if (index < 0) return; // Already granted; the grant above already settled this promise.
      waiters.splice(index, 1);
      settled = true;
      reject(abortError(signal!));
    };
    waiters.push(waiter);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function release(): void {
  const next = waiters.shift();
  if (next !== undefined) {
    // Hand off directly: `active` never observes a false window between one
    // holder releasing and the next waiter's grant, so a concurrent
    // `acquireImageStagePermit` call can never slip in as a second holder.
    next.grant();
    return;
  }
  active = false;
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new DOMException("The operation was aborted", "AbortError");
}

/** Test-only: true while a permit is held. */
export function isImageStagePermitActiveForTest(): boolean {
  return active;
}

/** Test-only: how many callers are parked waiting for the permit. */
export function imageStagePermitWaiterCountForTest(): number {
  return waiters.length;
}
