#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  lstatSync,
  readFileSync,
  realpathSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// This file ships standalone. test/release-launcher.test.ts enforces exact
// parity with shared/release-targets.ts, the canonical typed release policy.
export const LAUNCHER_PACKAGE_NAME = "@1667-ai/cli";
export const LAUNCHER_SOURCE_URL = "https://github.com/1667-ai/1667";
// Held targets stay in this table. Dropping one would make its platform report
// as unsupported, which is a different problem with a different fix: the
// platform is supported and builds from source, and only its package is withheld.
export const LAUNCHER_RELEASE_TARGETS = Object.freeze({
  "darwin-arm64": Object.freeze({
    packageName: "@1667-ai/darwin-arm64",
    os: "darwin",
    cpu: "arm64",
    libc: null,
    executable: "bin/1667",
    heldFromPublication: null
  }),
  "darwin-x64": Object.freeze({
    packageName: "@1667-ai/darwin-x64",
    os: "darwin",
    cpu: "x64",
    libc: null,
    executable: "bin/1667",
    heldFromPublication: null
  }),
  "linux-arm64": Object.freeze({
    packageName: "@1667-ai/linux-arm64",
    os: "linux",
    cpu: "arm64",
    libc: "glibc",
    executable: "bin/1667",
    heldFromPublication: null
  }),
  "linux-x64": Object.freeze({
    packageName: "@1667-ai/linux-x64",
    os: "linux",
    cpu: "x64",
    libc: "glibc",
    executable: "bin/1667",
    heldFromPublication: null
  }),
  "windows-x64": Object.freeze({
    packageName: "@1667-ai/windows-x64",
    os: "win32",
    cpu: "x64",
    libc: null,
    executable: "bin/1667.exe",
    heldFromPublication: "maintainers have not approved the Windows platform work "
      + "for publication"
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

export function resolveLaunchPlan(options = {}) {
  const launcherRoot = realpathSync(
    options.launcherRoot
      ?? path.dirname(path.dirname(fileURLToPath(import.meta.url)))
  );
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const args = options.args ?? process.argv.slice(2);
  const target = selectTarget(platform, arch);
  const policy = LAUNCHER_RELEASE_TARGETS[target];
  // A held target has no published package, so no install can supply one. Refuse
  // before touching the filesystem: what a user is told must not depend on what
  // a stray directory happens to contain.
  if (policy.heldFromPublication !== null) {
    throw new Error(heldTargetRefusal(target, policy));
  }

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
  return `${policy.packageName} is not published yet: ${policy.heldFromPublication}. `
    + `The ${target} target is supported and builds from source: ${LAUNCHER_SOURCE_URL}`;
}

export function runLauncher(options = {}) {
  const plan = resolveLaunchPlan(options);
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
