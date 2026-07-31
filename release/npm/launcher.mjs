#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { closeSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// This file ships standalone. test/release-launcher.test.ts enforces exact
// parity with shared/release-targets.ts, the canonical typed release policy.
export const LAUNCHER_PACKAGE_NAME = "@1667-ai/cli";
export const LAUNCHER_SOURCE_URL = "https://github.com/1667-ai/1667";
// Held targets stay in this table. Dropping one would make its platform report
// as unsupported, which is a different problem with a different fix: the
// platform is supported and builds from source, and only its package is
// withheld. Whether anything still verifies that build is what the hold reason
// says, so these strings are copied from the canonical policy verbatim.
export const LAUNCHER_RELEASE_TARGETS = Object.freeze({
  "darwin-arm64": Object.freeze({
    packageName: "@1667-ai/darwin-arm64",
    os: "darwin",
    cpu: "arm64",
    libc: null,
    executable: "bin/1667",
    minimumCpuFeature: null,
    minimumMacosVersion: "13.0",
    minimumGlibcVersion: null,
    heldFromPublication: null,
    heldAlternative: null
  }),
  "darwin-x64": Object.freeze({
    packageName: "@1667-ai/darwin-x64",
    os: "darwin",
    cpu: "x64",
    libc: null,
    executable: "bin/1667",
    minimumCpuFeature: "sse4.2",
    minimumMacosVersion: "13.0",
    minimumGlibcVersion: null,
    heldFromPublication: null,
    heldAlternative: null
  }),
  "linux-arm64": Object.freeze({
    packageName: "@1667-ai/linux-arm64",
    os: "linux",
    cpu: "arm64",
    libc: "glibc",
    executable: "bin/1667",
    minimumCpuFeature: null,
    minimumMacosVersion: null,
    minimumGlibcVersion: "2.17",
    heldFromPublication: null,
    heldAlternative: null
  }),
  "linux-x64": Object.freeze({
    packageName: "@1667-ai/linux-x64",
    os: "linux",
    cpu: "x64",
    libc: "glibc",
    executable: "bin/1667",
    minimumCpuFeature: "sse4.2",
    minimumMacosVersion: null,
    minimumGlibcVersion: "2.17",
    heldFromPublication: null,
    heldAlternative: null
  }),
  "windows-x64": Object.freeze({
    packageName: "@1667-ai/windows-x64",
    os: "win32",
    cpu: "x64",
    libc: null,
    executable: "bin/1667.exe",
    minimumCpuFeature: null,
    minimumMacosVersion: null,
    minimumGlibcVersion: null,
    heldFromPublication: null,
    heldAlternative: null
  })
});
const BUILD_MANIFEST_KEYS = new Set([
  "schemaVersion",
  "product",
  "productVersion",
  "sourceCommit",
  "buildTimestamp",
  "packageName",
  "artifactTarget"
]);
const MAX_JSON_BYTES = 64 * 1024;
const MAX_HOST_PROBE_BYTES = 1024 * 1024;
const CPU_INFO_CHUNK_BYTES = 64 * 1024;
const MAX_CPU_INFO_LINE_BYTES = 64 * 1024;
const HOST_PROBE_TIMEOUT_MS = 2_000;

export function resolveLaunchPlan(options = {}) {
  const { target, policy } = resolveLaunchTarget(options);
  return resolvePackageLaunchPlan(options, target, policy);
}

export function prepareLaunch(options = {}, observeHost = observeHostCompatibility) {
  const { target, policy } = resolveLaunchTarget(options);
  assertHostCompatibility(target, policy, observeHost(target));
  return resolvePackageLaunchPlan(options, target, policy);
}

function resolveLaunchTarget(options) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const target = selectTarget(platform, arch);
  const policy = LAUNCHER_RELEASE_TARGETS[target];
  // A held target has no published package, so no install can supply one. Refuse
  // before touching the filesystem: what a user is told must not depend on what
  // a stray directory happens to contain.
  if (policy.heldFromPublication !== null) {
    throw new Error(heldTargetRefusal(target, policy));
  }
  return { target, policy };
}

function resolvePackageLaunchPlan(options, target, policy) {
  const args = options.args ?? process.argv.slice(2);
  const launcherRoot = realpathSync(
    options.launcherRoot
      ?? path.dirname(path.dirname(fileURLToPath(import.meta.url)))
  );

  const launcherPackage = readBoundedJson(path.join(launcherRoot, "package.json"));
  const launcherBuild = parseBuildManifest(
    readBoundedJson(path.join(launcherRoot, "build-manifest.json")),
    LAUNCHER_PACKAGE_NAME,
    "launcher"
  );
  if (launcherPackage.name !== LAUNCHER_PACKAGE_NAME
    || launcherPackage.version !== launcherBuild.productVersion) {
    throw new Error("Launcher package and build manifest disagree");
  }
  const dependencyVersion = launcherPackage.optionalDependencies?.[policy.packageName];
  if (dependencyVersion !== launcherPackage.version) {
    throw new Error(`Launcher does not pin ${policy.packageName} at its exact version`);
  }

  let platformRoot;
  try {
    platformRoot = resolveLocalPlatformRoot(launcherRoot, policy.packageName);
  } catch {
    throw new Error(
      `Missing ${policy.packageName}@${launcherPackage.version}; reinstall 1667 for ${target}`
    );
  }
  const platformPackagePath = path.join(platformRoot, "package.json");
  const platformPackage = readBoundedJson(platformPackagePath);
  const platformBuild = parseBuildManifest(
    readBoundedJson(path.join(platformRoot, "build-manifest.json")),
    policy.packageName,
    target
  );
  if (platformPackage.name !== policy.packageName
    || platformPackage.version !== launcherPackage.version
    || platformBuild.productVersion !== launcherBuild.productVersion
    || platformBuild.sourceCommit !== launcherBuild.sourceCommit
    || platformBuild.buildTimestamp !== launcherBuild.buildTimestamp) {
    throw new Error("Launcher and platform package identities disagree");
  }
  const libcMatches = policy.libc === null
    ? !Object.hasOwn(platformPackage, "libc")
    : singleValue(platformPackage.libc, policy.libc);
  if (!singleValue(platformPackage.os, policy.os)
    || !singleValue(platformPackage.cpu, policy.cpu)
    || !libcMatches) {
    throw new Error(`${policy.packageName} declares the wrong target`);
  }

  const executable = path.join(platformRoot, policy.executable);
  const stat = lstatSync(executable);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${policy.packageName} executable is not a regular file`);
  }
  return Object.freeze({
    launcherRoot,
    platformRoot,
    executable,
    args: Object.freeze([...args]),
    target,
    packageName: policy.packageName,
    productVersion: launcherBuild.productVersion,
    sourceCommit: launcherBuild.sourceCommit
  });
}

function resolveLocalPlatformRoot(launcherRoot, packageName) {
  const peerRoot = path.resolve(
    launcherRoot,
    ...LAUNCHER_PACKAGE_NAME.split("/").map(() => "..")
  );
  const candidates = [path.join(launcherRoot, "node_modules", packageName)];
  if (path.basename(peerRoot) === "node_modules") {
    candidates.push(path.join(peerRoot, packageName));
  }
  const resolved = [];
  for (const candidate of new Set(candidates)) {
    try {
      const info = lstatSync(candidate);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      if (realpathSync(candidate) !== candidate) continue;
      readBoundedJson(path.join(candidate, "package.json"));
      resolved.push(candidate);
    } catch {
      // A missing or unsafe documented npm layout is not a candidate.
    }
  }
  if (resolved.length !== 1) {
    throw new Error(`Expected one local ${packageName} package`);
  }
  return resolved[0];
}

export function selectTarget(platform, arch) {
  const key = `${platform === "win32" ? "windows" : platform}-${arch}`;
  if (!Object.hasOwn(LAUNCHER_RELEASE_TARGETS, key)) {
    throw new Error(`Unsupported 1667 platform: ${platform}-${arch}`);
  }
  return key;
}

/**
 * Kept byte-identical with `heldTargetRefusal` in shared/release-targets.ts; a
 * test asserts the two produce the same string for the same target.
 */
export function heldTargetRefusal(target, policy) {
  const alternative = policy.heldAlternative === null
    ? ""
    : `${policy.heldAlternative} `;
  return `${policy.packageName} is not published yet: ${policy.heldFromPublication}. `
    + alternative
    + `The ${target} target is supported and builds from source: ${LAUNCHER_SOURCE_URL}`;
}

export function assertHostCompatibility(target, policy, observation) {
  if (policy.minimumCpuFeature === "sse4.2") {
    if (observation.cpuSupportsSse42 === null) {
      throw new Error(`Could not verify SSE4.2 support for the ${target} release.`);
    }
    if (!observation.cpuSupportsSse42) {
      throw new Error(`The ${target} release requires an x64 CPU with SSE4.2.`);
    }
  }
  assertMinimumHostVersion(target, "macOS", observation.macosVersion, policy.minimumMacosVersion);
  assertMinimumHostVersion(target, "glibc", observation.glibcVersion, policy.minimumGlibcVersion);
}

export function linuxCpuSupportsSse42(cpuInfo) {
  const parser = linuxCpuInfoParser();
  for (const line of cpuInfo.split("\n")) {
    if (Buffer.byteLength(line, "utf8") > MAX_CPU_INFO_LINE_BYTES) return null;
    consumeLinuxCpuInfoLine(parser, line);
  }
  return finishLinuxCpuInfo(parser);
}

export function darwinCpuSupportsSse42(features, arm64Capability) {
  if (arm64Capability?.trim() === "1") return true;
  if (features === null) return null;
  return features.trim().split(/\s+/u).includes("SSE4.2");
}

export function runLauncher(options = {}, observeHost) {
  const plan = prepareLaunch(options, observeHost);
  const child = spawn(plan.executable, plan.args, {
    stdio: "inherit",
    shell: false,
    windowsHide: true
  });
  const forwardedSignals = new Map();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const forward = () => child.kill(signal);
    forwardedSignals.set(signal, forward);
    process.once(signal, forward);
  }
  const removeForwarders = () => {
    for (const [signal, forward] of forwardedSignals) {
      process.removeListener(signal, forward);
    }
    forwardedSignals.clear();
  };
  child.once("error", (error) => {
    removeForwarders();
    process.stderr.write(`1667: could not start ${plan.packageName}: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    removeForwarders();
    if (signal !== null) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
  return child;
}

function observeHostCompatibility(target) {
  const [platform, arch] = target.split("-");
  let cpuSupportsSse42 = null;
  if (arch === "x64" && platform === "linux") {
    cpuSupportsSse42 = linuxCpuFileSupportsSse42("/proc/cpuinfo");
  } else if (arch === "x64" && platform === "darwin") {
    cpuSupportsSse42 = darwinCpuSupportsSse42(
      runHostProbe("/usr/sbin/sysctl", ["-n", "machdep.cpu.features"]),
      runHostProbe("/usr/sbin/sysctl", ["-n", "hw.optional.arm64"])
    );
  }
  return Object.freeze({
    cpuSupportsSse42,
    macosVersion: platform === "darwin"
      ? runHostProbe("/usr/bin/sw_vers", ["-productVersion"])
      : null,
    glibcVersion: platform === "linux" ? runtimeGlibcVersion() : null
  });
}

function assertMinimumHostVersion(target, name, observed, minimum) {
  if (minimum === null) return;
  const comparison = compareNumericVersions(observed, minimum);
  if (comparison === null) {
    throw new Error(`Could not verify the ${name} version for the ${target} release.`);
  }
  if (comparison < 0) {
    throw new Error(`The ${target} release requires ${name} ${minimum} or newer.`);
  }
}

function compareNumericVersions(observed, minimum) {
  if (typeof observed !== "string"
    || !/^[0-9]+(?:\.[0-9]+)*$/u.test(observed.trim())) {
    return null;
  }
  const observedParts = observed.trim().split(".").map(Number);
  const minimumParts = minimum.split(".").map(Number);
  const length = Math.max(observedParts.length, minimumParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (observedParts[index] ?? 0) - (minimumParts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function runtimeGlibcVersion() {
  try {
    const report = process.report.getReport();
    if (report === null || typeof report !== "object") return null;
    const header = report.header;
    if (header === null || typeof header !== "object") return null;
    const version = header.glibcVersionRuntime;
    return typeof version === "string" && version.trim() !== ""
      ? version.trim()
      : null;
  } catch {
    return null;
  }
}

export function linuxCpuFileSupportsSse42(file) {
  let descriptor;
  try {
    descriptor = openSync(file, "r");
    const bytes = Buffer.alloc(CPU_INFO_CHUNK_BYTES);
    let pending = "";
    const parser = linuxCpuInfoParser();
    while (true) {
      const count = readSync(descriptor, bytes, 0, bytes.length, null);
      if (count === 0) break;
      const lines = `${pending}${bytes.subarray(0, count).toString("utf8")}`
        .split("\n");
      pending = lines.pop() ?? "";
      if (Buffer.byteLength(pending, "utf8") > MAX_CPU_INFO_LINE_BYTES) {
        return null;
      }
      for (const line of lines) {
        if (Buffer.byteLength(line, "utf8") > MAX_CPU_INFO_LINE_BYTES) {
          return null;
        }
        consumeLinuxCpuInfoLine(parser, line);
        if (parser.unsupported) return false;
      }
    }
    consumeLinuxCpuInfoLine(parser, pending);
    return finishLinuxCpuInfo(parser);
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function linuxCpuInfoParser() {
  return {
    sawProcessor: false,
    inProcessor: false,
    processorHasFlags: false,
    unsupported: false,
    unverifiable: false
  };
}

function consumeLinuxCpuInfoLine(parser, line) {
  if (line.trim() === "") {
    finishLinuxCpuInfoRecord(parser);
    return;
  }
  if (/^\s*processor\s*:/u.test(line)) {
    finishLinuxCpuInfoRecord(parser);
    parser.sawProcessor = true;
    parser.inProcessor = true;
    return;
  }
  const match = /^\s*flags\s*:\s*(.*?)\s*$/u.exec(line);
  if (match === null || !parser.inProcessor) return;
  parser.processorHasFlags = true;
  if (!match[1].split(/\s+/u).includes("sse4_2")) {
    parser.unsupported = true;
  }
}

function finishLinuxCpuInfoRecord(parser) {
  if (parser.inProcessor && !parser.processorHasFlags) {
    parser.unverifiable = true;
  }
  parser.inProcessor = false;
  parser.processorHasFlags = false;
}

function finishLinuxCpuInfo(parser) {
  finishLinuxCpuInfoRecord(parser);
  if (parser.unsupported) return false;
  return parser.sawProcessor && !parser.unverifiable ? true : null;
}

function runHostProbe(executable, args) {
  try {
    const output = execFileSync(executable, args, {
      encoding: "utf8",
      maxBuffer: MAX_HOST_PROBE_BYTES,
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: HOST_PROBE_TIMEOUT_MS,
      windowsHide: true
    }).trim();
    return output === "" ? null : output;
  } catch {
    return null;
  }
}

function parseBuildManifest(value, packageName, artifactTarget) {
  const record = exactRecord(value, BUILD_MANIFEST_KEYS, "Package build manifest");
  if (record.schemaVersion !== 1
    || record.product !== "1667"
    || record.packageName !== packageName
    || record.artifactTarget !== artifactTarget
    || typeof record.productVersion !== "string"
    || typeof record.sourceCommit !== "string"
    || typeof record.buildTimestamp !== "string") {
    throw new Error(`${packageName} has an invalid build manifest`);
  }
  return record;
}

function readBoundedJson(file) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_JSON_BYTES) {
    throw new Error(`${file} is not a bounded regular JSON file`);
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

function exactRecord(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value);
  if (actual.length !== keys.size || actual.some((key) => !keys.has(key))) {
    throw new Error(`${label} has unknown or missing fields`);
  }
  return value;
}

function singleValue(value, expected) {
  return Array.isArray(value) && value.length === 1 && value[0] === expected;
}

function isMainModule() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try {
    runLauncher();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`1667: ${message}\n`);
    process.exitCode = 1;
  }
}
