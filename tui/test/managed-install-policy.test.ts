import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { canonicalNpmTarballUrl } from "../../shared/npm-tarball-url.js";
import { downloadPlatformPackage } from "../src/upgrade-download.js";
import { executeUpgradeCli } from "../src/upgrade-cli.js";
import { createUpgradeProgressRenderer } from "../src/upgrade-progress.js";
import {
  MANAGED_TEST_CURRENT as CURRENT,
  MANAGED_TEST_NEXT as NEXT,
  MANAGED_TEST_PACKAGE as PACKAGE,
  MANAGED_TEST_TARGET as TARGET,
  buildCanonicalPlatformPackage,
  fakeManagedRegistry,
  managedScratchRoot
} from "./managed-package-fixture.js";

test("canonical npm tarball URL accepts real scoped path and rejects encoding", async () => {
  const { assertCanonicalNpmTarballUrl } = await import("../../shared/npm-tarball-url.js");
  const real = "https://registry.npmjs.org/@1667-ai/darwin-arm64/-/darwin-arm64-0.1.1.tgz";
  expect(assertCanonicalNpmTarballUrl(real, "@1667-ai/darwin-arm64", "0.1.1")).toBe(real);
  let rejected = false;
  try {
    assertCanonicalNpmTarballUrl(
      "https://registry.npmjs.org/@1667-ai%2fdarwin-arm64/-/darwin-arm64-0.1.1.tgz",
      "@1667-ai/darwin-arm64",
      "0.1.1"
    );
  } catch {
    rejected = true;
  }
  expect(rejected).toBe(true);
  rejected = false;
  try {
    assertCanonicalNpmTarballUrl(`${real}?cache=1`, "@1667-ai/darwin-arm64", "0.1.1");
  } catch {
    rejected = true;
  }
  expect(rejected).toBe(true);
});

test("oversized download is refused with a small injected bound", async () => {
  const root = managedScratchRoot("policy-");
  try {
    const destination = path.join(root, "pkg.tgz");
    const body = new Uint8Array(64);
    let oversizeThrew = false;
    try {
      await downloadPlatformPackage({
        tarballUrl: canonicalNpmTarballUrl(PACKAGE, "1.0.0"),
        packageName: PACKAGE,
        version: "1.0.0",
        integrity: "sha512-" + "A".repeat(86) + "==",
        destinationPath: destination,
        signal: new AbortController().signal,
        maximumBytes: 16,
        fetcher: async () => new Response(body, {
          status: 200,
          headers: { "content-length": "64" }
        })
      });
    } catch {
      oversizeThrew = true;
    }
    expect(oversizeThrew).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("download progress is bounded when transport chunks are tiny", async () => {
  const root = managedScratchRoot("policy-progress-");
  try {
    const destination = path.join(root, "pkg.tgz");
    const body = new Uint8Array(1_000).fill(7);
    const progress: import("../src/upgrade-download.js").PackageDownloadProgress[] = [];
    await downloadPlatformPackage({
      tarballUrl: canonicalNpmTarballUrl(PACKAGE, "1.0.0"),
      packageName: PACKAGE,
      version: "1.0.0",
      integrity: `sha512-${createHash("sha512").update(body).digest("base64")}`,
      destinationPath: destination,
      signal: new AbortController().signal,
      onProgress: (event) => progress.push(event),
      fetcher: async () => new Response(new ReadableStream({
        start(controller) {
          for (const byte of body) controller.enqueue(new Uint8Array([byte]));
          controller.close();
        }
      }), {
        status: 200,
        headers: { "content-length": String(body.byteLength) }
      })
    });
    expect(progress.length <= 102).toBe(true);
    expect(progress[0]).toMatchObject({ downloadedBytes: 0, state: "active" });
    expect(progress.at(-1)).toMatchObject({
      downloadedBytes: body.byteLength,
      state: "complete"
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stalled package download headers are a retryable network failure", async () => {
  const root = managedScratchRoot("policy-headers-");
  try {
    const destination = path.join(root, "pkg.tgz");
    let cancelled = false;
    let failed: unknown;
    try {
      await downloadPlatformPackage({
        tarballUrl: canonicalNpmTarballUrl(PACKAGE, "1.0.0"),
        packageName: PACKAGE,
        version: "1.0.0",
        integrity: "sha512-" + "A".repeat(86) + "==",
        destinationPath: destination,
        signal: new AbortController().signal,
        // Short wall-clock only; idle stays long so header stall owns the failure.
        requestTimeoutMs: 30,
        idleTimeoutMs: 5_000,
        fetcher: (_input, init) => new Promise((_resolve, reject) => {
          const signal = init.signal as AbortSignal;
          const onAbort = () => {
            cancelled = true;
            reject(new DOMException("timed out", "AbortError"));
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        })
      });
    } catch (error) {
      failed = error;
    }
    expect(cancelled).toBe(true);
    const { UpgradeFailure } = await import("../src/upgrade-contract.js");
    expect(failed instanceof UpgradeFailure).toBe(true);
    const failure = failed as import("../src/upgrade-contract.js").UpgradeFailure;
    expect(failure.code).toBe("network_error");
    expect(failure.retryable).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stalled package download body idle is a retryable network failure", async () => {
  const root = managedScratchRoot("policy-body-");
  try {
    const destination = path.join(root, "pkg.tgz");
    let bodyCancelled = false;
    let failed: unknown;
    const progressWrites: string[] = [];
    try {
      await downloadPlatformPackage({
        tarballUrl: canonicalNpmTarballUrl(PACKAGE, "1.0.0"),
        packageName: PACKAGE,
        version: "1.0.0",
        integrity: "sha512-" + "A".repeat(86) + "==",
        destinationPath: destination,
        signal: new AbortController().signal,
        // Short idle; long wall so body silence is an idle failure, not wall-clock.
        requestTimeoutMs: 5_000,
        idleTimeoutMs: 40,
        onProgress: createUpgradeProgressRenderer((text) => progressWrites.push(text)),
        fetcher: async () => new Response(new ReadableStream({
          start(controller) {
            // Headers resolve; body never emits a chunk so the idle deadline fires.
            void controller;
          },
          cancel() {
            bodyCancelled = true;
          }
        }), { status: 200 })
      });
    } catch (error) {
      failed = error;
    }
    expect(bodyCancelled).toBe(true);
    const failure = failed as import("../src/upgrade-contract.js").UpgradeFailure;
    expect(failure.code).toBe("network_error");
    expect(failure.retryable).toBe(true);
    const progress = progressWrites.join("");
    expect(progress).not.toContain("100%");
    expect(progress.endsWith("\n")).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("slow-drip package body hits cumulative wall-clock deadline despite idle resets", async () => {
  const root = managedScratchRoot("policy-drip-");
  try {
    const destination = path.join(root, "pkg.tgz");
    let bodyCancelled = false;
    let chunkCount = 0;
    let failed: unknown;
    const started = Date.now();
    try {
      await downloadPlatformPackage({
        tarballUrl: canonicalNpmTarballUrl(PACKAGE, "1.0.0"),
        packageName: PACKAGE,
        version: "1.0.0",
        integrity: "sha512-" + "A".repeat(86) + "==",
        destinationPath: destination,
        signal: new AbortController().signal,
        // Short wall-clock; idle longer than drip interval so only cumulative fires.
        requestTimeoutMs: 80,
        idleTimeoutMs: 5_000,
        fetcher: async () => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          let stopped = false;
          return new Response(new ReadableStream({
            start(controller) {
              const drip = () => {
                if (stopped) return;
                chunkCount += 1;
                try {
                  controller.enqueue(new Uint8Array([1]));
                } catch {
                  // Stream already closed by abort; stop dripping.
                  stopped = true;
                  return;
                }
                // Never close: keep dripping until the wall-clock aborts.
                timer = setTimeout(drip, 15);
              };
              drip();
            },
            cancel() {
              stopped = true;
              if (timer !== undefined) clearTimeout(timer);
              bodyCancelled = true;
            }
          }), { status: 200 });
        }
      });
    } catch (error) {
      failed = error;
    }
    const elapsed = Date.now() - started;
    expect(bodyCancelled).toBe(true);
    // Multiple chunks prove idle reset; wall-clock still ends the transfer.
    expect(chunkCount).toBeGreaterThan(1);
    // The local expect type omits the greater-than-or-equal matcher.
    expect(elapsed >= 60).toBe(true);
    expect(elapsed < 2_000).toBe(true);
    const failure = failed as import("../src/upgrade-contract.js").UpgradeFailure;
    expect(failure.code).toBe("network_error");
    expect(failure.retryable).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("caller abort during package download remains interruption not timeout", async () => {
  const root = managedScratchRoot("policy-abort-");
  try {
    const destination = path.join(root, "pkg.tgz");
    const controller = new AbortController();
    let failed: unknown;
    const pending = downloadPlatformPackage({
      tarballUrl: canonicalNpmTarballUrl(PACKAGE, "1.0.0"),
      packageName: PACKAGE,
      version: "1.0.0",
      integrity: "sha512-" + "A".repeat(86) + "==",
      destinationPath: destination,
      signal: controller.signal,
      requestTimeoutMs: 5_000,
      fetcher: (_input, init) => new Promise((_resolve, reject) => {
        const signal = init.signal as AbortSignal;
        const onAbort = () => reject(new DOMException("aborted", "AbortError"));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      })
    });
    controller.abort();
    try {
      await pending;
    } catch (error) {
      failed = error;
    }
    const failure = failed as import("../src/upgrade-contract.js").UpgradeFailure;
    expect(failure.code).toBe("interrupted");
    expect(failure.retryable).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("canonical package fixtures reject missing required entries", async () => {
  const bad = buildCanonicalPlatformPackage({
    packageName: PACKAGE,
    version: NEXT,
    target: TARGET,
    omit: "package/LICENSE"
  });
  const root = managedScratchRoot("policy-");
  try {
    const dest = path.join(root, "cand");
    const { materializeCandidate } = await import("../src/upgrade-candidate.js");
    writeFileSync(path.join(root, "pkg.tgz"), bad.bytes);
    let materializeThrew = false;
    try {
      await materializeCandidate({
        packagePath: path.join(root, "pkg.tgz"),
        destinationPath: dest,
        packageName: PACKAGE,
        version: NEXT,
        signal: new AbortController().signal
      });
    } catch (error) {
      materializeThrew = /LICENSE|missing|policy|digest/i.test(String(error));
    }
    expect(materializeThrew).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed extraction accepts a future NOTICE but keeps archive safety policy", async () => {
  const { materializeCandidate } = await import("../src/upgrade-candidate.js");
  const root = managedScratchRoot("policy-notice-");
  try {
    const futureNotice = "Copyright 2027 1667 contributors.\n";
    const cases = [
      {
        label: "future NOTICE",
        package: buildCanonicalPlatformPackage({
          packageName: PACKAGE,
          version: NEXT,
          target: TARGET,
          noticeBody: futureNotice
        }),
        accepted: true
      },
      {
        label: "empty NOTICE",
        package: buildCanonicalPlatformPackage({
          packageName: PACKAGE,
          version: NEXT,
          target: TARGET,
          noticeBody: ""
        }),
        accepted: false
      },
      {
        label: "unsafe NOTICE mode",
        package: buildCanonicalPlatformPackage({
          packageName: PACKAGE,
          version: NEXT,
          target: TARGET,
          badMode: "package/NOTICE"
        }),
        accepted: false
      }
    ] as const;
    for (const sample of cases) {
      const destination = path.join(root, `candidate-${sample.label.replaceAll(" ", "-")}`);
      writeFileSync(path.join(root, `${sample.label}.tgz`), sample.package.bytes);
      let accepted = true;
      try {
        await materializeCandidate({
          packagePath: path.join(root, `${sample.label}.tgz`),
          destinationPath: destination,
          packageName: PACKAGE,
          version: NEXT,
          signal: new AbortController().signal
        });
      } catch {
        accepted = false;
      }
      expect(accepted).toBe(sample.accepted);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("package build-manifest accepts real release schema; rejects skew", async () => {
  const { createReleasePackageBuildManifest } =
    await import("../../scripts/release-package-templates.js");
  const { extractPlatformPackageExecutable } =
    await import("../../shared/release-tar-extract.js");
  const evidence = {
    productVersion: NEXT,
    sourceCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    buildTimestamp: "2026-07-29T12:00:00.000Z"
  };
  const goodManifest = createReleasePackageBuildManifest(evidence, PACKAGE, TARGET);
  const good = buildCanonicalPlatformPackage({
    packageName: PACKAGE,
    version: NEXT,
    target: TARGET,
    buildManifestBody: JSON.stringify(goodManifest),
    sourceCommit: evidence.sourceCommit,
    buildTimestamp: evidence.buildTimestamp
  });
  const root = managedScratchRoot("policy-");
  try {
    const dest = path.join(root, "cand-good");
    const extracted = await extractPlatformPackageExecutable(good.bytes, {
      packageName: PACKAGE,
      version: NEXT,
      destinationPath: dest
    });
    expect(extracted.buildManifest).toMatchObject({
      schemaVersion: 1,
      product: "1667",
      productVersion: NEXT,
      packageName: PACKAGE,
      artifactTarget: TARGET,
      sourceCommit: evidence.sourceCommit,
      buildTimestamp: evidence.buildTimestamp
    });
    // Executable identity probe remains the full BuildIdentity contract.
    expect(extracted.executablePath).toBe(dest);

    // Full BuildIdentity shape in package/build-manifest.json is not accepted.
    const identityShaped = buildCanonicalPlatformPackage({
      packageName: PACKAGE,
      version: NEXT,
      target: TARGET,
      buildManifestBody: JSON.stringify({
        schemaVersion: 1,
        product: "1667",
        productVersion: NEXT,
        buildKind: "release",
        sourceCommit: evidence.sourceCommit,
        sourceDirty: false,
        buildTimestamp: evidence.buildTimestamp,
        artifactTarget: TARGET,
        apiProtocolVersion: 10,
        minClientProtocolVersion: 10,
        maxClientProtocolVersion: 10
      })
    });
    let identityReject = false;
    try {
      await extractPlatformPackageExecutable(identityShaped.bytes, {
        packageName: PACKAGE,
        version: NEXT,
        destinationPath: path.join(root, "cand-identity")
      });
    } catch {
      identityReject = true;
    }
    expect(identityReject).toBe(true);

    // Identity skew: wrong packageName / version / target fails closed.
    const skewed = buildCanonicalPlatformPackage({
      packageName: PACKAGE,
      version: NEXT,
      target: TARGET,
      buildManifestBody: JSON.stringify({
        ...goodManifest,
        productVersion: CURRENT
      })
    });
    let skewReject = false;
    try {
      await extractPlatformPackageExecutable(skewed.bytes, {
        packageName: PACKAGE,
        version: NEXT,
        destinationPath: path.join(root, "cand-skew")
      });
    } catch {
      skewReject = true;
    }
    expect(skewReject).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("extract cumulative file bytes use total-file bound not executable bound", async () => {
  const { extractPlatformPackageExecutable } =
    await import("../../shared/release-tar-extract.js");
  const pkg = buildCanonicalPlatformPackage({
    packageName: PACKAGE,
    version: NEXT,
    target: TARGET
  });
  // Fixture metadata: executable body is strictly smaller than total regular files.
  expect(pkg.executableBytes).toBeGreaterThan(0);
  expect(pkg.regularFileBytes).toBeGreaterThan(pkg.executableBytes);

  const root = managedScratchRoot("policy-");
  try {
    // Production bounds accept the package.
    await extractPlatformPackageExecutable(pkg.bytes, {
      packageName: PACKAGE,
      version: NEXT,
      destinationPath: path.join(root, "cand-ok")
    });

    // Cumulative inject below total payload rejects (executable room stays large).
    let rejected = false;
    try {
      await extractPlatformPackageExecutable(pkg.bytes, {
        packageName: PACKAGE,
        version: NEXT,
        destinationPath: path.join(root, "cand-bound"),
        maximumTotalFileBytes: pkg.regularFileBytes - 1,
        maximumExecutableBytes: pkg.executableBytes + 1
      });
    } catch (error) {
      rejected = /file bytes exceed the release bound|outside the size bound|release bound/i
        .test(String(error));
    }
    expect(rejected).toBe(true);

    // Executable max is above the executable entry but below cumulative regular-file
    // bytes; total-file max is above cumulative. Success proves cumulative is not
    // limited by the executable bound.
    expect(pkg.executableBytes + 1).toBeLessThan(pkg.regularFileBytes);
    await extractPlatformPackageExecutable(pkg.bytes, {
      packageName: PACKAGE,
      version: NEXT,
      destinationPath: path.join(root, "cand-exec-below-total"),
      maximumTotalFileBytes: pkg.regularFileBytes + 1,
      maximumExecutableBytes: pkg.executableBytes + 1
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("external installations stay read-only", async () => {
  const result = await executeUpgradeCli(["--json"], {
    authority: { kind: "manual" },
    observation: {
      currentVersion: CURRENT,
      platformPackage: PACKAGE,
      },
    registry: fakeManagedRegistry(
      NEXT,
      PACKAGE,
      "sha512-" + "A".repeat(86) + "==",
      canonicalNpmTarballUrl(PACKAGE, NEXT)
    )
  });
  expect(result.exitCode).toBe(0);
  expect(result.envelope).toMatchObject({
    status: "manual",
    method: "manual",
    restartRequired: false
  });
});
