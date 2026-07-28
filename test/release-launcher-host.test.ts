import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertHostCompatibility,
  darwinCpuSupportsSse42,
  LAUNCHER_RELEASE_TARGETS,
  linuxCpuFileSupportsSse42,
  linuxCpuSupportsSse42,
  runLauncher,
  type HostCompatibilityObservation
} from "../release/npm/launcher.mjs";

const MISSING_ROOT = "/path-that-does-not-exist/1667-launcher";

test("launcher refuses an x64 CPU without SSE4.2 before package access", () => {
  assert.throws(
    () => runLauncher(
      {
        launcherRoot: MISSING_ROOT,
        platform: "linux",
        arch: "x64"
      },
      () => observation({
        cpuSupportsSse42: false,
        glibcVersion: "2.17"
      })
    ),
    {
      message: "The linux-x64 release requires an x64 CPU with SSE4.2."
    }
  );
});

test("launcher refuses old macOS before package access", () => {
  assert.throws(
    () => runLauncher(
      {
        launcherRoot: MISSING_ROOT,
        platform: "darwin",
        arch: "arm64"
      },
      () => observation({ macosVersion: "12.7.6" })
    ),
    {
      message: "The darwin-arm64 release requires macOS 13.0 or newer."
    }
  );
});

test("launcher refuses old glibc before package access", () => {
  assert.throws(
    () => runLauncher(
      {
        launcherRoot: MISSING_ROOT,
        platform: "linux",
        arch: "arm64"
      },
      () => observation({ glibcVersion: "2.16" })
    ),
    {
      message: "The linux-arm64 release requires glibc 2.17 or newer."
    }
  );
});

test("launcher accepts the exact supported host boundaries", () => {
  assert.doesNotThrow(() => assertHostCompatibility(
    "darwin-x64",
    LAUNCHER_RELEASE_TARGETS["darwin-x64"]!,
    observation({
      cpuSupportsSse42: true,
      macosVersion: "13.0"
    })
  ));
  assert.doesNotThrow(() => assertHostCompatibility(
    "linux-x64",
    LAUNCHER_RELEASE_TARGETS["linux-x64"]!,
    observation({
      cpuSupportsSse42: true,
      glibcVersion: "2.17"
    })
  ));
});

test("arm64 host checks do not require an x64 CPU observation", () => {
  assert.doesNotThrow(() => assertHostCompatibility(
    "darwin-arm64",
    LAUNCHER_RELEASE_TARGETS["darwin-arm64"]!,
    observation({ macosVersion: "13.0" })
  ));
  assert.doesNotThrow(() => assertHostCompatibility(
    "linux-arm64",
    LAUNCHER_RELEASE_TARGETS["linux-arm64"]!,
    observation({ glibcVersion: "2.17" })
  ));
});

test("launcher fails closed when SSE4.2 support is unavailable", () => {
  assert.throws(
    () => assertHostCompatibility(
      "linux-x64",
      LAUNCHER_RELEASE_TARGETS["linux-x64"]!,
      observation({ glibcVersion: "2.17" })
    ),
    {
      message: "Could not verify SSE4.2 support for the linux-x64 release."
    }
  );
});

test("launcher fails closed when the macOS version is malformed", () => {
  assert.throws(
    () => assertHostCompatibility(
      "darwin-arm64",
      LAUNCHER_RELEASE_TARGETS["darwin-arm64"]!,
      observation({ macosVersion: "not-a-version" })
    ),
    {
      message: "Could not verify the macOS version for the darwin-arm64 release."
    }
  );
});

test("launcher fails closed when the glibc version is unavailable", () => {
  assert.throws(
    () => assertHostCompatibility(
      "linux-arm64",
      LAUNCHER_RELEASE_TARGETS["linux-arm64"]!,
      observation({ glibcVersion: null })
    ),
    {
      message: "Could not verify the glibc version for the linux-arm64 release."
    }
  );
});

test("Linux CPU parsing requires an exact flag on every processor", () => {
  assert.equal(
    linuxCpuSupportsSse42("processor: 0\nflags: fpu sse4_2 avx\n"),
    true
  );
  assert.equal(
    linuxCpuSupportsSse42("processor: 0\nflags: fpu nosse4_2 avx\n"),
    false
  );
  assert.equal(
    linuxCpuSupportsSse42(
      "processor: 0\nflags: fpu sse4_2\nprocessor: 1\nflags: fpu sse2\n"
    ),
    false
  );
  assert.equal(
    linuxCpuSupportsSse42(
      "processor: 0\nflags: fpu sse4_2\nprocessor: 1\n"
    ),
    null
  );
  assert.equal(linuxCpuSupportsSse42("processor: 0\nFeatures: fp\n"), null);
});

test("Linux CPU scanning accepts a large valid processor inventory", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "1667-cpu-info-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "cpuinfo");
  const cpuInfo = Array.from(
    { length: 40_000 },
    (_, index) => `processor: ${index}\nflags: fpu sse4_2 avx\n`
  ).join("");
  assert.ok(Buffer.byteLength(cpuInfo, "utf8") > 1024 * 1024);
  await writeFile(file, cpuInfo);
  assert.equal(linuxCpuFileSupportsSse42(file), true);
});

test("Linux CPU scanning rejects a processor record without flags", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "1667-cpu-info-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "cpuinfo");
  await writeFile(
    file,
    "processor: 0\nflags: fpu sse4_2 avx\n\nprocessor: 1\nmodel name: Example\n"
  );
  assert.equal(linuxCpuFileSupportsSse42(file), null);
});

test("macOS CPU parsing accepts exact SSE4.2 or Rosetta support", () => {
  assert.equal(darwinCpuSupportsSse42("SSE2 SSE4.2 AVX1.0", "0"), true);
  assert.equal(darwinCpuSupportsSse42("SSE2 NOSSE4.2 AVX1.0", "0"), false);
  assert.equal(darwinCpuSupportsSse42(null, "1"), true);
  assert.equal(darwinCpuSupportsSse42(null, null), null);
});

function observation(
  fields: Partial<HostCompatibilityObservation>
): HostCompatibilityObservation {
  return {
    cpuSupportsSse42: null,
    macosVersion: null,
    glibcVersion: null,
    ...fields
  };
}
