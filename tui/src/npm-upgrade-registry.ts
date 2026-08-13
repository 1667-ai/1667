import { NPM_METADATA_MAX_BYTES as SHARED_NPM_METADATA_MAX_BYTES } from "../../shared/release-artifact-bounds.js";
import {
  assertCanonicalNpmTarballUrl,
  NPM_REGISTRY_ORIGIN as SHARED_NPM_REGISTRY_ORIGIN
} from "../../shared/npm-tarball-url.js";
import { distTagForChannel } from "../../shared/release-dist-tags.js";
import { compareSemVer, isSemVer, parseSemVer } from "../../shared/semver.js";
import { parseJsonRejectingDuplicateKeys } from "../../shared/strict-json.js";
import {
  PUBLISHED_PLATFORM_PACKAGES,
  RELEASE_LAUNCHER_PACKAGE,
  registryPathForPackage,
  releaseTargetForPackage,
  type PublishedPlatformPackage
} from "../../shared/release-targets.js";
import {
  UpgradeFailure,
  type UpgradeChannel
} from "./upgrade-contract.js";

export const NPM_REGISTRY_ORIGIN = SHARED_NPM_REGISTRY_ORIGIN;
export const NPM_METADATA_MAX_BYTES = SHARED_NPM_METADATA_MAX_BYTES;
export const NPM_VERSION_INDEX_MAX_BYTES = 1024 * 1024;
export const LAUNCHER_PACKAGE = RELEASE_LAUNCHER_PACKAGE;
// The registry only answers for packages that were published, so a held
// target's package is not something this client may look up or expect.
export const PLATFORM_PACKAGES = PUBLISHED_PLATFORM_PACKAGES;

export type PlatformPackage = PublishedPlatformPackage;
export type RegistryFetch = (input: string, init: RequestInit) => Promise<Response>;

/** The scope every package of this product is published under. */
const RELEASE_SCOPE = `${LAUNCHER_PACKAGE.slice(0, LAUNCHER_PACKAGE.indexOf("/"))}/`;

/** The name part an npm package in that scope can have. */
const SCOPED_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

interface ExactMetadataExpectation {
  name: string;
  version: string;
  optionalDependencies?: Readonly<Record<string, string>>;
  /**
   * Verify the launcher graph by rule, and keep the platform package named here
   * a required member of it.
   */
  launcherGraph?: Readonly<{ requiredPlatformPackage: string }>;
  platform?: Readonly<{
    os: string;
    cpu: string;
    libc: string | null;
  }>;
}

export interface NpmVersionMetadata {
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
  readonly tarball: string;
}

export class NpmUpgradeRegistry {
  constructor(
    private readonly fetcher: RegistryFetch = (input, init) => fetch(input, init),
    private readonly timeoutMs = 5_000
  ) {}

  async availableVersions(signal: AbortSignal): Promise<readonly string[]> {
    const body = await this.get(
      `/${registryPathForPackage(LAUNCHER_PACKAGE)}`,
      signal,
      "application/vnd.npm.install-v1+json",
      NPM_VERSION_INDEX_MAX_BYTES
    );
    return parseNpmAvailableVersions(body);
  }

  async channelHead(channel: UpgradeChannel, signal: AbortSignal): Promise<string> {
    const body = await this.get(
      `/-/package/${registryPathForPackage(LAUNCHER_PACKAGE)}/dist-tags`,
      signal
    );
    return parseNpmDistTags(body, channel);
  }

  async launcher(
    version: string,
    platformPackage: PlatformPackage,
    signal: AbortSignal
  ): Promise<NpmVersionMetadata> {
    return parseNpmExactVersionMetadata(
      await this.get(
        `/${registryPathForPackage(LAUNCHER_PACKAGE)}/${encodeURIComponent(version)}`,
        signal
      ),
      {
        name: LAUNCHER_PACKAGE,
        version,
        launcherGraph: { requiredPlatformPackage: platformPackage }
      }
    );
  }

  async platform(
    packageName: PlatformPackage,
    version: string,
    signal: AbortSignal
  ): Promise<NpmVersionMetadata> {
    const target = releaseTargetForPackage(packageName);
    if (target === null) throw metadataFailure();
    return parseNpmExactVersionMetadata(
      await this.get(
        `/${registryPathForPackage(packageName)}/${encodeURIComponent(version)}`,
        signal
      ),
      {
        name: packageName,
        version,
        optionalDependencies: {},
        platform: {
          os: target.platform,
          cpu: target.arch,
          libc: target.libc
        }
      }
    );
  }

  private async get(
    path: string,
    signal: AbortSignal,
    accept = "application/json",
    maxBytes = NPM_METADATA_MAX_BYTES
  ): Promise<Uint8Array> {
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(new DOMException("Registry request timed out", "TimeoutError")),
      this.timeoutMs
    );
    try {
      return await this.getWithSignal(
        path,
        signal,
        AbortSignal.any([signal, timeout.signal]),
        accept,
        maxBytes
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async getWithSignal(
    path: string,
    callerSignal: AbortSignal,
    requestSignal: AbortSignal,
    accept: string,
    maxBytes: number
  ): Promise<Uint8Array> {
    let response: Response;
    try {
      response = await this.fetcher(`${NPM_REGISTRY_ORIGIN}${path}`, {
        method: "GET",
        headers: { accept },
        redirect: "error",
        signal: requestSignal
      });
    } catch {
      if (callerSignal.aborted) throw interruptedFailure();
      throw new UpgradeFailure("network_error", "Could not check for updates.", true);
    }
    if (response.status === 404) {
      await cancelResponse(response);
      throw new UpgradeFailure("unsupported_target", "The requested release is not available.");
    }
    if (!response.ok) {
      await cancelResponse(response);
      throw new UpgradeFailure(
        "network_error",
        "Could not check for updates.",
        response.status === 429 || response.status >= 500
      );
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json" && contentType !== accept) {
      await cancelResponse(response);
      throw metadataFailure();
    }
    return readBoundedBody(response, callerSignal, maxBytes);
  }
}

/** Published, non-deprecated launcher releases, newest first. */
export function parseNpmAvailableVersions(
  body: Uint8Array | string
): readonly string[] {
  const value = parseBoundedJson(body, NPM_VERSION_INDEX_MAX_BYTES);
  if (!isRecord(value) || value.name !== LAUNCHER_PACKAGE || !isRecord(value.versions)) {
    throw metadataFailure();
  }
  const entries = Object.entries(value.versions);
  if (entries.length === 0 || entries.length > 1024) throw metadataFailure();
  const versions: string[] = [];
  for (const [key, metadata] of entries) {
    if (!isSemVer(key) || !isRecord(metadata) || metadata.name !== LAUNCHER_PACKAGE
      || metadata.version !== key) {
      throw metadataFailure();
    }
    const deprecated = metadata.deprecated;
    if (deprecated !== undefined && typeof deprecated !== "string") throw metadataFailure();
    if ((deprecated === undefined || deprecated.length === 0)
      && !Object.hasOwn(metadata, "revoked")) versions.push(key);
  }
  versions.sort((left, right) => compareSemVer(right, left));
  return Object.freeze(versions);
}

export function parseNpmDistTags(
  body: Uint8Array | string,
  channel: UpgradeChannel
): string {
  const value = parseBoundedJson(body);
  if (!isRecord(value)) throw metadataFailure();
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > 64) throw metadataFailure();
  for (const [tag, version] of entries) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(tag)
      || typeof version !== "string"
      || version.length > 128
      || hasControlCharacter(version)
      || !isSemVer(version)) {
      throw metadataFailure();
    }
  }
  const selected = value[distTagForChannel(channel)];
  if (typeof selected !== "string") {
    throw new UpgradeFailure("unsupported_target", `The ${channel} channel has no release.`);
  }
  if (channel === "stable" && parseSemVer(selected)!.prerelease.length > 0) {
    throw new UpgradeFailure("verification_failed", "The stable channel selected a prerelease.");
  }
  return selected;
}

export function parseNpmExactVersionMetadata(
  body: Uint8Array | string,
  expected: ExactMetadataExpectation
): NpmVersionMetadata {
  const value = parseBoundedJson(body);
  if (!isRecord(value)) throw metadataFailure();
  const name = boundedString(value.name, 214);
  const version = boundedSemVer(value.version);
  if (name !== expected.name || version !== expected.version) {
    throw new UpgradeFailure("verification_failed", "Registry package identity did not match the target.");
  }
  const deprecated = value.deprecated;
  if ((deprecated !== undefined && deprecated !== "") || Object.hasOwn(value, "revoked")) {
    throw new UpgradeFailure("unsupported_target", "The requested release is deprecated or revoked.");
  }
  if (!isRecord(value.dist)) throw metadataFailure();
  const integrity = boundedString(value.dist.integrity, 256);
  if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)) {
    throw new UpgradeFailure("verification_failed", "Registry integrity metadata is missing or invalid.");
  }
  const tarball = boundedString(value.dist.tarball, 2048);
  try {
    assertCanonicalNpmTarballUrl(tarball, name, version);
  } catch {
    throw new UpgradeFailure("verification_failed", "Registry tarball URL is invalid.");
  }
  verifyDependencyGraph(value, expected);
  if (expected.platform !== undefined) {
    verifyPlatformIdentity(
      value,
      expected.platform.os,
      expected.platform.cpu,
      expected.platform.libc
    );
  } else if (Object.hasOwn(value, "libc")) {
    throw platformIdentityFailure();
  }
  return Object.freeze({ name, version, integrity, tarball });
}

function verifyDependencyGraph(
  metadata: Record<string, unknown>,
  expected: ExactMetadataExpectation
): void {
  const value = metadata.optionalDependencies;
  if (expected.launcherGraph !== undefined) {
    verifyLauncherGraph(
      value,
      expected.version,
      expected.launcherGraph.requiredPlatformPackage
    );
  } else if (value === undefined
    && Object.keys(expected.optionalDependencies ?? {}).length === 0) {
    // Omitted and empty are equivalent for an intentionally dependency-free package.
  } else {
    verifyOptionalDependencies(value, expected.optionalDependencies ?? {});
  }
  for (const field of ["dependencies", "peerDependencies"] as const) {
    const graph = metadata[field];
    if (graph !== undefined && (!isRecord(graph) || Object.keys(graph).length !== 0)) {
      throw dependencyFailure();
    }
  }
  for (const field of ["bundledDependencies", "bundleDependencies"] as const) {
    const bundled = metadata[field];
    if (bundled !== undefined && (!Array.isArray(bundled) || bundled.length !== 0)) {
      throw dependencyFailure();
    }
  }
}

/**
 * The launcher graph is verified by rule, and never against a list of platform
 * packages that this build carries.
 *
 * A later release publishes a platform target that an earlier build knows
 * nothing about. A list refuses that release, and every release after it, for
 * the life of the installation, and the refusal happens inside the installed
 * build, where no fix can reach it. A rule accepts the new name and keeps what
 * the check is for: the launcher depends on packages of this product alone,
 * each one pinned to the exact version this upgrade verified.
 */
function verifyLauncherGraph(
  value: unknown,
  version: string,
  requiredPlatformPackage: string
): void {
  if (!isRecord(value)) throw dependencyFailure();
  const entries = Object.entries(value);
  if (entries.length > 64) throw metadataFailure();
  for (const [name, pinned] of entries) {
    boundedString(name, 214);
    boundedSemVer(pinned);
    if (!isReleaseScopePackage(name) || name === LAUNCHER_PACKAGE || pinned !== version) {
      throw dependencyFailure();
    }
  }
  // A release that no longer carries this installation's platform must stop
  // here, and not at a later request for a package the registry never received.
  if (!Object.hasOwn(value, requiredPlatformPackage)) throw dependencyFailure();
}

/** True for a package this product publishes, such as `@1667-ai/linux-x64`. */
function isReleaseScopePackage(name: string): boolean {
  return name.startsWith(RELEASE_SCOPE)
    && SCOPED_NAME.test(name.slice(RELEASE_SCOPE.length));
}

function verifyOptionalDependencies(
  value: unknown,
  expected: Readonly<Record<string, string>>
): void {
  if (!isRecord(value)) throw dependencyFailure();
  const entries = Object.entries(value);
  if (entries.length > 64) throw metadataFailure();
  for (const [name, version] of entries) {
    boundedString(name, 214);
    boundedSemVer(version);
  }
  const expectedEntries = Object.entries(expected);
  if (entries.length !== expectedEntries.length
    || expectedEntries.some(([name, version]) => value[name] !== version)) {
    throw dependencyFailure();
  }
}

function verifyPlatformIdentity(
  metadata: Record<string, unknown>,
  os: string,
  cpu: string,
  libc: string | null
): void {
  const libcMatches = libc === null
    ? !Object.hasOwn(metadata, "libc")
    : singleStringArrayEquals(metadata.libc, libc);
  if (!singleStringArrayEquals(metadata.os, os)
    || !singleStringArrayEquals(metadata.cpu, cpu)
    || !libcMatches) {
    throw platformIdentityFailure();
  }
}

function platformIdentityFailure(): UpgradeFailure {
  return new UpgradeFailure(
    "verification_failed",
    "Registry platform metadata did not match the target."
  );
}

function singleStringArrayEquals(value: unknown, expected: string): boolean {
  return Array.isArray(value) && value.length === 1 && value[0] === expected;
}

async function readBoundedBody(
  response: Response,
  callerSignal: AbortSignal,
  maxBytes: number
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    await cancelResponse(response);
    throw metadataFailure();
  }
  if (response.body === null) throw metadataFailure();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maxBytes) throw metadataFailure();
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof UpgradeFailure) {
      await reader.cancel().catch(() => undefined);
      throw error;
    }
    if (callerSignal.aborted) throw interruptedFailure();
    throw new UpgradeFailure("network_error", "Could not check for updates.", true);
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function cancelResponse(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function parseBoundedJson(
  body: Uint8Array | string,
  maxBytes = NPM_METADATA_MAX_BYTES
): unknown {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) throw metadataFailure();
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return parseJsonRejectingDuplicateKeys(text);
  } catch {
    throw metadataFailure();
  }
}

function boundedString(value: unknown, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength
    || hasControlCharacter(value)) {
    throw metadataFailure();
  }
  return value;
}

function boundedSemVer(value: unknown): string {
  const version = boundedString(value, 128);
  if (!isSemVer(version)) throw metadataFailure();
  return version;
}

function hasControlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function metadataFailure(): UpgradeFailure {
  return new UpgradeFailure("metadata_invalid", "Update metadata was invalid.");
}

function dependencyFailure(): UpgradeFailure {
  return new UpgradeFailure("verification_failed", "The package dependency graph is invalid.");
}

function interruptedFailure(): UpgradeFailure {
  return new UpgradeFailure("interrupted", "The update check was interrupted.");
}
