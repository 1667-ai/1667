import { expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  MANAGED_TEST_NEXT as NEXT,
  MANAGED_TEST_PACKAGE as PACKAGE,
  MANAGED_TEST_TARGET as TARGET,
  buildCanonicalPlatformPackage,
  managedScratchRoot
} from "./managed-package-fixture.js";

test("extract abort on stalled gzip input settles and cleans staging", async () => {
  const { extractPlatformPackageExecutable } =
    await import("../../shared/release-tar-extract.js");
  const root = managedScratchRoot("extract-abort-");
  try {
    const destination = path.join(root, "candidate");
    const staging = `${destination}.extract.${process.pid}`;
    const controller = new AbortController();
    async function* stalledGzip(): AsyncGenerator<Uint8Array> {
      // Partial gzip magic so gunzip starts; then hang until abort settles the pipeline.
      yield new Uint8Array([0x1f, 0x8b, 0x08, 0x00]);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 30_000);
        controller.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
      if (controller.signal.aborted) {
        throw new DOMException("The operation was aborted", "AbortError");
      }
      yield new Uint8Array([0]);
    }
    const pending = extractPlatformPackageExecutable(stalledGzip(), {
      packageName: PACKAGE,
      version: NEXT,
      destinationPath: destination,
      signal: controller.signal
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort();
    let failed: unknown;
    try {
      await pending;
    } catch (error) {
      failed = error;
    }
    expect(failed instanceof Error).toBe(true);
    const err = failed as Error;
    expect(err.name === "AbortError" || /abort/i.test(err.message)).toBe(true);
    expect(existsSync(destination)).toBe(false);
    expect(existsSync(staging)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("materializeCandidate maps extract abort to interrupted UpgradeFailure", async () => {
  const { materializeCandidate } = await import("../src/upgrade-candidate.js");
  const { UpgradeFailure } = await import("../src/upgrade-contract.js");
  const root = managedScratchRoot("materialize-abort-");
  try {
    const pkg = buildCanonicalPlatformPackage({
      packageName: PACKAGE,
      version: NEXT,
      target: TARGET
    });
    const packagePath = path.join(root, "pkg.tgz");
    const destination = path.join(root, "candidate");
    writeFileSync(packagePath, pkg.bytes);
    const controller = new AbortController();
    controller.abort();
    let failed: unknown;
    try {
      await materializeCandidate({
        packagePath,
        destinationPath: destination,
        packageName: PACKAGE,
        version: NEXT,
        signal: controller.signal
      });
    } catch (error) {
      failed = error;
    }
    expect(failed instanceof UpgradeFailure).toBe(true);
    const failure = failed as import("../src/upgrade-contract.js").UpgradeFailure;
    expect(failure.code).toBe("interrupted");
    expect(failure.retryable).toBe(false);
    expect(existsSync(destination)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shared transfer policy pins wall 600s and managed body-idle 60s", async () => {
  const bounds = await import("../../shared/release-artifact-bounds.js");
  const download = await import("../src/upgrade-download.js");
  expect(bounds.RELEASE_TRANSFER_TOTAL_TIMEOUT_MS).toBe(600_000);
  expect(bounds.RELEASE_TRANSFER_BODY_IDLE_TIMEOUT_MS).toBe(60_000);
  expect(download.DEFAULT_PACKAGE_DOWNLOAD_TIMEOUT_MS).toBe(600_000);
  expect(download.DEFAULT_PACKAGE_DOWNLOAD_IDLE_TIMEOUT_MS).toBe(60_000);
  expect(download.DEFAULT_PACKAGE_DOWNLOAD_TIMEOUT_MS)
    .toBe(bounds.RELEASE_TRANSFER_TOTAL_TIMEOUT_MS);
  expect(download.DEFAULT_PACKAGE_DOWNLOAD_IDLE_TIMEOUT_MS)
    .toBe(bounds.RELEASE_TRANSFER_BODY_IDLE_TIMEOUT_MS);
});
