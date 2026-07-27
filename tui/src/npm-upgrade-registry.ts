import { isSemVer, parseSemVer } from "../../shared/semver.js";
import { parseJsonRejectingDuplicateKeys } from "../../shared/strict-json.js";
import {
  RELEASE_LAUNCHER_PACKAGE,
  RELEASE_PLATFORM_PACKAGES,
  registryPathForPackage,
  releasePlatformDependencyGraph,
  releaseTargetForPackage,
  type ReleasePlatformPackage
} from "../../shared/release-targets.js";
import {
  UpgradeFailure,
  type UpgradeChannel
} from "./upgrade-contract.js";

export const NPM_REGISTRY_ORIGIN = "https://registry.npmjs.org";
export const NPM_METADATA_MAX_BYTES = 64 * 1024;
export const LAUNCHER_PACKAGE = RELEASE_LAUNCHER_PACKAGE;
export const PLATFORM_PACKAGES = RELEASE_PLATFORM_PACKAGES;

export type PlatformPackage = ReleasePlatformPackage;
export type RegistryFetch = (input: string, init: RequestInit) => Promise<Response>;

interface ExactMetadataExpectation {
  name: string;
  version: string;
  optionalDependencies?: Readonly<Record<string, string>>;
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
}

export class NpmUpgradeRegistry {
  constructor(
    private readonly fetcher: RegistryFetch = (input, init) => fetch(input, init),
    private readonly timeoutMs = 5_000
  ) {}

  async channelHead(channel: UpgradeChannel, signal: AbortSignal): Promise<string> {
    const body = await this.get(
      `/-/package/${registryPathForPackage(LAUNCHER_PACKAGE)}/dist-tags`,
      signal
    );
    return parseNpmDistTags(body, channel);
  }

  async launcher(
    version: string,
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
        optionalDependencies: releasePlatformDependencyGraph(version)
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

  private async get(path: string, signal: AbortSignal): Promise<Uint8Array> {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const requestSignal = AbortSignal.any([signal, timeoutSignal]);
    let response: Response;
    try {
      response = await this.fetcher(`${NPM_REGISTRY_ORIGIN}${path}`, {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "error",
        signal: requestSignal
      });
    } catch {
      if (signal.aborted) throw interruptedFailure();
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
    if (contentType !== "application/json") {
      await cancelResponse(response);
      throw metadataFailure();
    }
    return readBoundedBody(response, signal);
  }
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
  const selected = value[channel];
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
  if (Object.hasOwn(value, "deprecated") || Object.hasOwn(value, "revoked")) {
    throw new UpgradeFailure("unsupported_target", "The requested release is deprecated or revoked.");
  }
  if (!isRecord(value.dist)) throw metadataFailure();
  const integrity = boundedString(value.dist.integrity, 256);
  if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)) {
    throw new UpgradeFailure("verification_failed", "Registry integrity metadata is missing or invalid.");
  }
  verifyDependencyGraph(value, expected.optionalDependencies ?? {});
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
  return Object.freeze({ name, version, integrity });
}

function verifyDependencyGraph(
  metadata: Record<string, unknown>,
  expected: Readonly<Record<string, string>>
): void {
  const value = metadata.optionalDependencies;
  if (value === undefined && Object.keys(expected).length === 0) {
    // Omitted and empty are equivalent for an intentionally dependency-free package.
  } else {
    verifyOptionalDependencies(value, expected);
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

async function readBoundedBody(response: Response, callerSignal: AbortSignal): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > NPM_METADATA_MAX_BYTES)) {
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
      if (length > NPM_METADATA_MAX_BYTES) throw metadataFailure();
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

function parseBoundedJson(body: Uint8Array | string): unknown {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  if (bytes.byteLength === 0 || bytes.byteLength > NPM_METADATA_MAX_BYTES) throw metadataFailure();
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
