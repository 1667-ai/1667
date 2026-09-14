#!/usr/bin/env -S node --import tsx

import {
  copyFileSync,
  mkdirSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isSemVer } from "../shared/semver.js";
import {
  desktopMetadataCandidates,
  desktopMetadataName,
  rewriteDesktopMetadata,
  stagedDesktopMetadataName
} from "./release-desktop-metadata.js";

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const DEFAULT_REPOSITORY = "1667-ai/1667";
const TARGETS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "windows-x64"
] as const;

export type DesktopReleaseTarget = typeof TARGETS[number];

interface TargetSpec {
  readonly target: DesktopReleaseTarget;
  readonly archiveSuffix: ".dmg" | ".zip" | ".exe" | ".AppImage";
}

const TARGET_SPECS: readonly TargetSpec[] = Object.freeze([
  { target: "darwin-arm64", archiveSuffix: ".zip" },
  { target: "darwin-x64", archiveSuffix: ".zip" },
  { target: "linux-arm64", archiveSuffix: ".AppImage" },
  { target: "linux-x64", archiveSuffix: ".AppImage" },
  { target: "windows-x64", archiveSuffix: ".exe" }
]);

const BUILD_DIAGNOSTICS = new Set([
  "builder-debug.yml",
  "builder-effective-config.yaml",
  "builder-effective-config.yml"
]);

export interface StageDesktopReleaseOptions {
  readonly version: string;
  readonly target: DesktopReleaseTarget;
  /** Directory produced by one electron-builder target invocation. */
  readonly sourceDirectory: string;
  /** Flat directory that receives the normalized release assets. */
  readonly outputDirectory: string;
  /** GitHub repository used in the absolute archive URLs in updater metadata. */
  readonly repository?: string;
}

export interface StagedDesktopRelease {
  readonly target: DesktopReleaseTarget;
  readonly version: string;
  readonly files: readonly string[];
}

export function desktopReleaseTargets(): readonly DesktopReleaseTarget[] {
  return TARGETS;
}

/**
 * Returns the final names that one target contributes to the GitHub release.
 * Blockmaps are retained where electron-builder emits a separate file because
 * electron-updater uses them for differential downloads. AppImage embeds its
 * blockmap, so Linux contributes no separate blockmap asset. Metadata stays
 * target-specific so the homepage can publish one generic feed per platform.
 */
export function desktopAssetNames(
  version: string,
  target: DesktopReleaseTarget
): readonly string[] {
  assertVersion(version);
  const spec = targetSpec(target);
  const base = `1667-${version}-${target}`;
  return Object.freeze([
    target.startsWith("darwin-") ? `1667-${version}-${target}.dmg` : null,
    `${base}${spec.archiveSuffix}`,
    target.startsWith("linux-") ? null : `${base}${spec.archiveSuffix}.blockmap`,
    desktopMetadataName(version, target)
  ].filter((name): name is string => name !== null));
}

export function allDesktopAssetNames(version: string): readonly string[] {
  assertVersion(version);
  return Object.freeze([...new Set(
    TARGETS.flatMap((target) => desktopAssetNames(version, target))
  )].sort(compareNames));
}

export function desktopReleaseArchiveUrl(
  version: string,
  target: DesktopReleaseTarget,
  repository = DEFAULT_REPOSITORY
): string {
  assertVersion(version);
  assertRepository(repository);
  const names = desktopAssetNames(version, target);
  const archive = names.find((name) => name.endsWith(target.startsWith("darwin-") ? ".zip" : target.startsWith("linux-") ? ".AppImage" : ".exe"));
  if (archive === undefined) throw new Error(`Desktop target ${target} has no archive`);
  return `https://github.com/${repository}/releases/download/v${version}/${archive}`;
}

/**
 * Normalizes one electron-builder output directory and rewrites its updater
 * metadata to the exact GitHub archive URL for this release target.
 */
export function stageDesktopRelease(
  options: StageDesktopReleaseOptions
): StagedDesktopRelease {
  assertVersion(options.version);
  const spec = targetSpec(options.target);
  const repository = options.repository ?? DEFAULT_REPOSITORY;
  assertRepository(repository);
  const source = regularDirectory(options.sourceDirectory, "Desktop build output");
  const destination = path.resolve(options.outputDirectory);
  mkdirSync(destination, { recursive: true });

  const entries = readdirSync(source, { withFileTypes: true });
  if (entries.some((entry) => entry.isSymbolicLink()
    || (!entry.isFile()
      && !BUILD_DIAGNOSTICS.has(entry.name)
      && !/^\.icon-(?:icns|ico|set)$/u.test(entry.name)
      && !isBuilderUnpackedDirectory(entry.name)))) {
    throw new Error("Desktop build output contains an unsupported entry");
  }
  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  const archiveSource = oneFile(files, (name) => {
    return name.endsWith(spec.archiveSuffix) && !name.endsWith(".blockmap");
  }, `${options.target} archive`);
  const dmgSource = options.target.startsWith("darwin-")
    ? oneFile(files, (name) => name.endsWith(".dmg"), `${options.target} DMG`)
    : null;
  const blockmapSource = options.target.startsWith("linux-")
    ? null
    : oneFile(files, (name) => {
      return name.endsWith(`${spec.archiveSuffix}.blockmap`);
    }, `${options.target} blockmap`);
  const metadataSource = selectMetadataSource(files, options.version, options.target);

  const expected = desktopAssetNames(options.version, options.target);
  const archiveName = expected.find((name) => name.endsWith(spec.archiveSuffix))!;
  const blockmapName = `${archiveName}.blockmap`;
  const metadataName = stagedDesktopMetadataName(options.version, options.target);
  const ignored = new Set([
    archiveSource,
    ...(dmgSource === null ? [] : [dmgSource]),
    ...(blockmapSource === null ? [] : [blockmapSource]),
    metadataSource,
    ...desktopMetadataCandidates(options.version, options.target),
    ...BUILD_DIAGNOSTICS
  ]);
  const unexpected = files.filter((name) => !ignored.has(name));
  if (unexpected.length > 0) {
    throw new Error(`Desktop build output contains unexpected files: ${unexpected.join(", ")}`);
  }

  const outputNames = [
    ...(options.target.startsWith("darwin-") ? [`1667-${options.version}-${options.target}.dmg`] : []),
    archiveName,
    ...(blockmapSource === null ? [] : [blockmapName]),
    metadataName
  ];
  for (const name of outputNames) {
    const existing = path.join(destination, name);
    if (exists(existing)) throw new Error(`Desktop release asset already exists: ${name}`);
  }
  copyFileSync(path.join(source, archiveSource), path.join(destination, archiveName));
  if (blockmapSource !== null) {
    copyFileSync(path.join(source, blockmapSource), path.join(destination, blockmapName));
  }
  if (dmgSource !== null) {
    copyFileSync(
      path.join(source, dmgSource),
      path.join(destination, `1667-${options.version}-${options.target}.dmg`)
    );
  }
  const metadata = rewriteDesktopMetadata(
    readFileSync(path.join(source, metadataSource), "utf8"),
    archiveSource,
    archiveName,
    blockmapSource,
    blockmapName,
    desktopReleaseArchiveUrl(options.version, options.target, repository),
    options.target,
  );
  writeFileSync(path.join(destination, metadataName), metadata);
  return Object.freeze({
    target: options.target,
    version: options.version,
    files: Object.freeze(outputNames.map((name) => path.join(destination, name)))
  });
}

/** Verify the one target output before the matrix artifacts are merged. */
export function verifyDesktopTargetAssetDirectory(
  directory: string,
  version: string,
  target: DesktopReleaseTarget,
  repository = DEFAULT_REPOSITORY
): readonly string[] {
  assertVersion(version);
  assertRepository(repository);
  const root = regularDirectory(directory, "Desktop target assets");
  const entries = readdirSync(root, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
    throw new Error("Desktop target assets must be regular files");
  }
  const names = entries.map((entry) => entry.name).sort(compareNames);
  const expected = [...stagedDesktopAssetNames(version, target)].sort(compareNames);
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    throw new Error(`Desktop target ${target} contains an unexpected asset set`);
  }
  verifyDesktopTargetContents(root, version, target, repository);
  return Object.freeze(expected.map((name) => path.join(root, name)));
}

/** Merge matrix outputs and verify target-specific metadata. */
export function mergeDesktopReleaseAssets(
  directory: string,
  version: string,
  repository = DEFAULT_REPOSITORY
): readonly string[] {
  assertVersion(version);
  assertRepository(repository);
  const root = regularDirectory(directory, "Desktop release assets");
  const expectedStaged = [...TARGETS.flatMap((target) => stagedDesktopAssetNames(version, target))].sort(compareNames);
  const names = readdirSync(root, { withFileTypes: true }).map((entry) => entry.name).sort(compareNames);
  if (names.length !== expectedStaged.length || names.some((name, index) => name !== expectedStaged[index])) {
    throw new Error("Desktop matrix contains an unexpected asset set");
  }
  return verifyDesktopReleaseAssetDirectory(root, version, repository);
}

/** Verifies the exact flat desktop asset set for all five targets. */
export function verifyDesktopReleaseAssetDirectory(
  directory: string,
  version: string,
  repository = DEFAULT_REPOSITORY
): readonly string[] {
  assertVersion(version);
  assertRepository(repository);
  const root = regularDirectory(directory, "Desktop release assets");
  const entries = readdirSync(root, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
    throw new Error("Desktop release assets must be regular files");
  }
  const names = entries.map((entry) => entry.name).sort(compareNames);
  const expected = [...allDesktopAssetNames(version)];
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    throw new Error("Desktop release contains an unexpected asset set");
  }
  verifyDesktopAssetContents(root, version, repository);
  return Object.freeze(expected.map((name) => path.join(root, name)));
}

/** Verifies desktop assets inside a combined GitHub release directory. */
export function verifyDesktopAssetsInReleaseDirectory(
  directory: string,
  version: string,
  repository = DEFAULT_REPOSITORY
): readonly string[] {
  assertVersion(version);
  assertRepository(repository);
  const root = regularDirectory(directory, "GitHub release assets");
  const expected = [...allDesktopAssetNames(version)];
  for (const name of expected) {
    const file = path.join(root, name);
    if (!isRegularFile(file) || lstatSync(file).size <= 0) {
      throw new Error(`GitHub release is missing desktop asset ${name}`);
    }
  }
  verifyDesktopAssetContents(root, version, repository);
  return Object.freeze(expected.map((name) => path.join(root, name)));
}

function verifyDesktopAssetContents(root: string, version: string, repository: string): void {
  for (const target of TARGETS) {
    const metadataName = desktopMetadataName(version, target);
    const body = readFileSync(path.join(root, metadataName), "utf8");
    if (!body.includes(`version: ${version}`)) {
      throw new Error(`Desktop metadata ${metadataName} has the wrong version`);
    }
    const archiveUrl = desktopReleaseArchiveUrl(version, target, repository);
    if (!body.includes(`url: ${archiveUrl}`)) {
      throw new Error(`Desktop metadata ${metadataName} has the wrong archive URL`);
    }
    const archiveName = path.basename(archiveUrl);
    if (!body.includes(`path: ${archiveName}`)) {
      throw new Error(`Desktop metadata ${metadataName} has the wrong archive path`);
    }
  }
}

function verifyDesktopTargetContents(
  root: string,
  version: string,
  target: DesktopReleaseTarget,
  repository: string
): void {
  const metadataName = stagedDesktopMetadataName(version, target);
  const body = readFileSync(path.join(root, metadataName), "utf8");
  const archiveUrl = desktopReleaseArchiveUrl(version, target, repository);
  if (!body.includes(`url: ${archiveUrl}`) || !body.includes(`path: ${path.basename(archiveUrl)}`)) {
    throw new Error(`Desktop metadata ${metadataName} does not name its normalized archive`);
  }
}

function stagedDesktopAssetNames(
  version: string,
  target: DesktopReleaseTarget
): readonly string[] {
  return desktopAssetNames(version, target).map((name) => name === desktopMetadataName(version, target)
    ? stagedDesktopMetadataName(version, target)
    : name);
}

function selectMetadataSource(
  files: readonly string[],
  version: string,
  target: DesktopReleaseTarget
): string {
  const source = desktopMetadataCandidates(version, target).find((candidate) => files.includes(candidate));
  if (source === undefined) {
    throw new Error(`${target} updater metadata must have exactly one file`);
  }
  return source;
}

function isBuilderUnpackedDirectory(name: string): boolean {
  return /^(?:linux|win)(?:-[a-z0-9]+)?-unpacked$|^mac(?:-[a-z0-9]+)?$/u.test(name);
}

function targetSpec(target: DesktopReleaseTarget): TargetSpec {
  const spec = TARGET_SPECS.find((candidate) => candidate.target === target);
  if (spec === undefined) throw new Error(`Unsupported desktop release target ${target}`);
  return spec;
}

function oneFile(
  files: readonly string[],
  predicate: (name: string) => boolean,
  label: string
): string {
  const matches = files.filter(predicate);
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new Error(`${label} must have exactly one file`);
  }
  return matches[0];
}

function regularDirectory(value: string, label: string): string {
  const requested = lstatSync(value);
  if (!requested.isDirectory() || requested.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
  return realpathSync(value);
}

function isRegularFile(value: string): boolean {
  try {
    const stat = lstatSync(value);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function exists(value: string): boolean {
  try {
    lstatSync(value);
    return true;
  } catch {
    return false;
  }
}

function assertVersion(version: string): void {
  if (!isSemVer(version)) throw new Error(`Desktop release version is not SemVer: ${version}`);
}

function assertRepository(repository: string): void {
  if (!REPOSITORY.test(repository)) throw new Error("Desktop release repository is invalid");
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isMainModule(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

const USAGE = [
  "usage: release-desktop-assets.ts <command>",
  "  targets",
  "  stage <version> <target> <source> <output> [repository]",
  "  verify-target <version> <target> <directory> [repository]",
  "  merge <version> <directory> [repository]",
  "  verify <version> <directory> [repository]"
].join("\n");

if (isMainModule()) {
  try {
    const [command, ...rest] = process.argv.slice(2);
    if (command === "targets" && rest.length === 0) {
      process.stdout.write(`${JSON.stringify(TARGETS)}\n`);
    } else if (command === "stage" && (rest.length === 4 || rest.length === 5)) {
      const [version, target, source, output, repository = DEFAULT_REPOSITORY] = rest;
      if (version === undefined || target === undefined || source === undefined || output === undefined) {
        throw new Error(USAGE);
      }
      const staged = stageDesktopRelease({
        version,
        target: target as DesktopReleaseTarget,
        sourceDirectory: source,
        outputDirectory: output,
        repository
      });
      process.stdout.write(`${staged.files.map((file) => path.basename(file)).join("\n")}\n`);
    } else if (command === "verify-target" && (rest.length === 3 || rest.length === 4)) {
      const [version, target, directory, repository = DEFAULT_REPOSITORY] = rest;
      if (version === undefined || target === undefined || directory === undefined) {
        throw new Error(USAGE);
      }
      const files = verifyDesktopTargetAssetDirectory(
        directory,
        version,
        target as DesktopReleaseTarget,
        repository
      );
      process.stdout.write(`verified ${files.length} ${target} desktop assets\n`);
    } else if (command === "merge" && (rest.length === 2 || rest.length === 3)) {
      const [version, directory, repository = DEFAULT_REPOSITORY] = rest;
      if (version === undefined || directory === undefined) throw new Error(USAGE);
      const files = mergeDesktopReleaseAssets(directory, version, repository);
      process.stdout.write(`merged ${files.length} desktop release assets\n`);
    } else if (command === "verify" && (rest.length === 2 || rest.length === 3)) {
      const [version, directory, repository = DEFAULT_REPOSITORY] = rest;
      if (version === undefined || directory === undefined) throw new Error(USAGE);
      const files = verifyDesktopReleaseAssetDirectory(directory, version, repository);
      process.stdout.write(`verified ${files.length} desktop release assets\n`);
    } else {
      throw new Error(USAGE);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`release-desktop-assets: ${message}\n`);
    process.exitCode = 1;
  }
}
