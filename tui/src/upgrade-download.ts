import { createHash } from "node:crypto";
import { closeSync, fsyncSync, lstatSync } from "node:fs";
import {
  MAX_RELEASE_ARTIFACT_GZIP_BYTES,
  RELEASE_TRANSFER_BODY_IDLE_TIMEOUT_MS,
  RELEASE_TRANSFER_TOTAL_TIMEOUT_MS
} from "../../shared/release-artifact-bounds.js";
import { integrityMatches } from "../../shared/release-tar-extract.js";
import { assertCanonicalNpmTarballUrl } from "../../shared/npm-tarball-url.js";
import {
  openExclusiveWrite,
  removeQuietly,
  writeAll
} from "../../shared/safe-file-write.js";
import { UpgradeFailure } from "./upgrade-contract.js";

export type PackageFetch = (input: string, init: RequestInit) => Promise<Response>;

/** Cumulative wall-clock deadline for headers plus the complete body (600s). */
export const DEFAULT_PACKAGE_DOWNLOAD_TIMEOUT_MS = RELEASE_TRANSFER_TOTAL_TIMEOUT_MS;
/** Body-idle bound between chunks; independent of the wall-clock deadline (60s). */
export const DEFAULT_PACKAGE_DOWNLOAD_IDLE_TIMEOUT_MS = RELEASE_TRANSFER_BODY_IDLE_TIMEOUT_MS;

/**
 * Streams a platform package tarball to a private staging file with a hard
 * cumulative byte bound and verifies the npm SHA-512 integrity value.
 */
export async function downloadPlatformPackage(options: {
  readonly tarballUrl: string;
  readonly packageName: string;
  readonly version: string;
  readonly integrity: string;
  readonly destinationPath: string;
  readonly signal: AbortSignal;
  readonly fetcher?: PackageFetch;
  readonly maximumBytes?: number;
  /** Deterministic short wall-clock timeout for tests; defaults to production. */
  readonly requestTimeoutMs?: number;
  /** Deterministic short body-idle timeout for tests; defaults to production. */
  readonly idleTimeoutMs?: number;
}): Promise<{ readonly bytes: number; readonly sha512Hex: string }> {
  const maximum = options.maximumBytes ?? MAX_RELEASE_ARTIFACT_GZIP_BYTES;
  const wallTimeoutMs = options.requestTimeoutMs ?? DEFAULT_PACKAGE_DOWNLOAD_TIMEOUT_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_PACKAGE_DOWNLOAD_IDLE_TIMEOUT_MS;
  try {
    assertCanonicalNpmTarballUrl(options.tarballUrl, options.packageName, options.version);
  } catch {
    throw new UpgradeFailure("verification_failed", "Registry tarball URL is invalid.");
  }
  const fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  refuseUnsafeStagingPath(options.destinationPath, "Release package staging path");
  // Only unlink a regular non-symlink file after the safety check.
  try {
    const existing = lstatSync(options.destinationPath);
    if (existing.isFile() && !existing.isSymbolicLink()) {
      removeQuietly(options.destinationPath);
    }
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
  }

  // One non-resetting wall-clock deadline for headers and the complete body.
  // Idle (below) still resets per chunk; a slow-drip body cannot hold forever.
  const wallTimeout = new AbortController();
  const wallTimer = setTimeout(
    () => wallTimeout.abort(new DOMException("Package download timed out", "TimeoutError")),
    wallTimeoutMs
  );
  let response: Response | undefined;
  try {
    try {
      response = await fetcher(options.tarballUrl, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.any([options.signal, wallTimeout.signal])
      });
    } catch {
      if (options.signal.aborted) {
        throw new UpgradeFailure("interrupted", "The update was interrupted.");
      }
      throw new UpgradeFailure("network_error", "Could not download the release package.", true);
    }
    if (!response.ok || response.body === null) {
      await cancelResponseBody(response);
      throw new UpgradeFailure(
        response.status === 404 ? "unsupported_target" : "network_error",
        response.status === 404
          ? "The requested release is not available."
          : "Could not download the release package.",
        response.status === 429 || response.status >= 500
      );
    }
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
      await cancelResponseBody(response);
      throw new UpgradeFailure("verification_failed", "Release package size is outside the bound.");
    }

    const hash = createHash("sha512");
    let fd: number | null = null;
    let bytes = 0;
    const idleTimeout = new AbortController();
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const resetIdleDeadline = (): void => {
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => idleTimeout.abort(
          new DOMException("Package download body idle timed out", "TimeoutError")
        ),
        idleTimeoutMs
      );
    };
    try {
      fd = openExclusiveWrite(options.destinationPath, 0o600);
      const reader = response.body.getReader();
      resetIdleDeadline();
      try {
        while (true) {
          if (
            options.signal.aborted
            || idleTimeout.signal.aborted
            || wallTimeout.signal.aborted
          ) {
            await reader.cancel().catch(() => undefined);
            if (options.signal.aborted) {
              throw new UpgradeFailure("interrupted", "The update was interrupted.");
            }
            throw new UpgradeFailure(
              "network_error",
              "Could not download the release package.",
              true
            );
          }
          const next = await readChunkWithSignals(
            reader,
            options.signal,
            idleTimeout.signal,
            wallTimeout.signal
          );
          if (next.done) break;
          resetIdleDeadline();
          const chunk = next.value;
          if (chunk.byteLength > maximum - bytes) {
            await reader.cancel().catch(() => undefined);
            throw new UpgradeFailure(
              "verification_failed",
              "Release package size is outside the bound."
            );
          }
          bytes += chunk.byteLength;
          hash.update(chunk);
          writeAll(fd, chunk);
        }
      } finally {
        if (idleTimer !== null) clearTimeout(idleTimer);
        reader.releaseLock();
      }
      if (bytes === 0) {
        throw new UpgradeFailure("verification_failed", "Release package size is outside the bound.");
      }
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
    } catch (error) {
      if (idleTimer !== null) clearTimeout(idleTimer);
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // Best effort.
        }
      }
      removeQuietly(options.destinationPath);
      await cancelResponseBody(response);
      if (error instanceof UpgradeFailure) throw error;
      if (options.signal.aborted) {
        throw new UpgradeFailure("interrupted", "The update was interrupted.");
      }
      throw new UpgradeFailure("network_error", "Could not download the release package.", true);
    }

    const sha512Hex = hash.digest("hex");
    if (!integrityMatches(options.integrity, sha512Hex)) {
      removeQuietly(options.destinationPath);
      throw new UpgradeFailure(
        "verification_failed",
        "Release package integrity did not match the registry metadata."
      );
    }
    return Object.freeze({ bytes, sha512Hex });
  } finally {
    clearTimeout(wallTimer);
  }
}

export function refuseUnsafeStagingPath(destinationPath: string, label: string): void {
  try {
    const existing = lstatSync(destinationPath);
    if (existing.isSymbolicLink()) {
      throw new UpgradeFailure(
        "verification_failed",
        `${label} must not be a symbolic link.`
      );
    }
    if (!existing.isFile()) {
      throw new UpgradeFailure(
        "verification_failed",
        `${label} is not a regular file.`
      );
    }
  } catch (error) {
    if (error instanceof UpgradeFailure) throw error;
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
  }
}

async function readChunkWithSignals(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  callerSignal: AbortSignal,
  idleSignal: AbortSignal,
  wallSignal: AbortSignal
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (callerSignal.aborted || idleSignal.aborted || wallSignal.aborted) {
    await reader.cancel().catch(() => undefined);
    if (callerSignal.aborted) {
      throw new UpgradeFailure("interrupted", "The update was interrupted.");
    }
    throw new UpgradeFailure("network_error", "Could not download the release package.", true);
  }
  return await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      callerSignal.removeEventListener("abort", onAbort);
      idleSignal.removeEventListener("abort", onAbort);
      wallSignal.removeEventListener("abort", onAbort);
      void reader.cancel().catch(() => undefined);
      if (callerSignal.aborted) {
        reject(new UpgradeFailure("interrupted", "The update was interrupted."));
      } else {
        reject(new UpgradeFailure(
          "network_error",
          "Could not download the release package.",
          true
        ));
      }
    };
    callerSignal.addEventListener("abort", onAbort, { once: true });
    idleSignal.addEventListener("abort", onAbort, { once: true });
    wallSignal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => {
        if (settled) return;
        settled = true;
        callerSignal.removeEventListener("abort", onAbort);
        idleSignal.removeEventListener("abort", onAbort);
        wallSignal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error) => {
        if (settled) return;
        settled = true;
        callerSignal.removeEventListener("abort", onAbort);
        idleSignal.removeEventListener("abort", onAbort);
        wallSignal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

async function cancelResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}
