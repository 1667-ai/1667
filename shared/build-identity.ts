import packageManifest from "../package.json" with { type: "json" };
import { isSemVer } from "./semver.js";
import {
  PACKAGED_ARTIFACT_TARGETS,
  type PackagedArtifactTarget
} from "./release-targets.js";

export {
  PACKAGED_ARTIFACT_TARGETS,
  type PackagedArtifactTarget
} from "./release-targets.js";

export const AI_1667_PRODUCT = "1667" as const;
export const HTTP_API_PROTOCOL_VERSION = 5;
export const HTTP_MIN_CLIENT_PROTOCOL_VERSION = 5;
export const HTTP_MAX_CLIENT_PROTOCOL_VERSION = 5;

export type ArtifactTarget = "source" | PackagedArtifactTarget;

interface CommonBuildIdentity {
  schemaVersion: 1;
  product: typeof AI_1667_PRODUCT;
  productVersion: string;
  apiProtocolVersion: number;
  minClientProtocolVersion: number;
  maxClientProtocolVersion: number;
}

interface PackagedBuildProvenance {
  artifactTarget: PackagedArtifactTarget;
  sourceCommit: string;
  buildTimestamp: string;
}

export type BuildIdentity = CommonBuildIdentity & ({
  artifactTarget: "source";
  sourceCommit: null;
  sourceDirty: null;
  buildTimestamp: null;
  buildKind: "development";
} | (PackagedBuildProvenance & (
  { buildKind: "development"; sourceDirty: boolean }
  | { buildKind: "release"; sourceDirty: false }
)));

export interface PackagedBuildIdentityInput {
  productVersion: string;
  sourceCommit: string;
  sourceDirty: boolean;
  buildTimestamp: string;
  artifactTarget: PackagedArtifactTarget;
}

const BUILD_IDENTITY_FIELDS = {
  schemaVersion: true,
  product: true,
  productVersion: true,
  buildKind: true,
  sourceCommit: true,
  sourceDirty: true,
  buildTimestamp: true,
  artifactTarget: true,
  apiProtocolVersion: true,
  minClientProtocolVersion: true,
  maxClientProtocolVersion: true
} satisfies Record<keyof BuildIdentity, true>;
const BUILD_IDENTITY_KEYS = Object.keys(BUILD_IDENTITY_FIELDS) as (keyof BuildIdentity)[];
const BUILD_IDENTITY_KEY_SET = new Set<string>(BUILD_IDENTITY_KEYS);
const SOURCE_COMMIT = /^[0-9a-f]{40}$/;

// Bun replaces this single object literal in both compiled entrypoints. Source
// runs take the explicit non-release branch and never infer identity from env.
declare const __AI_1667_BUILD_IDENTITY__: unknown;

export function createSourceBuildIdentity(productVersion = packageManifest.version): BuildIdentity {
  return parseBuildIdentity({
    ...commonIdentity(productVersion),
    buildKind: "development",
    artifactTarget: "source",
    sourceCommit: null,
    sourceDirty: null,
    buildTimestamp: null
  });
}

export function createPackagedBuildIdentity(input: PackagedBuildIdentityInput): BuildIdentity {
  return parseBuildIdentity({
    ...commonIdentity(input.productVersion),
    buildKind: "development",
    artifactTarget: input.artifactTarget,
    sourceCommit: input.sourceCommit,
    sourceDirty: input.sourceDirty,
    buildTimestamp: input.buildTimestamp
  });
}

export function parseBuildIdentity(value: unknown): BuildIdentity {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Build identity must be an object");
  }
  const identity = value as Record<string, unknown>;
  const keys = Object.keys(identity);
  if (keys.length !== BUILD_IDENTITY_KEYS.length || keys.some((key) => !BUILD_IDENTITY_KEY_SET.has(key))) {
    throw new Error("Build identity has unknown or missing fields");
  }
  if (identity.schemaVersion !== 1 || identity.product !== AI_1667_PRODUCT) {
    throw new Error("Build identity has an unsupported schema or product");
  }
  if (!isSemVer(identity.productVersion)) {
    throw new Error("Build identity has an invalid product version");
  }
  if (identity.buildKind !== "development" && identity.buildKind !== "release") {
    throw new Error("Build identity has an invalid build kind");
  }
  const common: CommonBuildIdentity = {
    schemaVersion: 1,
    product: AI_1667_PRODUCT,
    productVersion: identity.productVersion,
    ...parseProtocolRange(identity)
  };

  if (identity.artifactTarget === "source") {
    if (identity.buildKind !== "development" || identity.sourceCommit !== null
      || identity.sourceDirty !== null || identity.buildTimestamp !== null) {
      throw new Error("Source identity cannot claim packaged build provenance");
    }
    return {
      ...common,
      buildKind: "development",
      artifactTarget: "source",
      sourceCommit: null,
      sourceDirty: null,
      buildTimestamp: null
    };
  }
  if (!isPackagedArtifactTarget(identity.artifactTarget)) {
    throw new Error("Build identity has an unsupported artifact target");
  }
  if (typeof identity.sourceCommit !== "string" || !SOURCE_COMMIT.test(identity.sourceCommit)) {
    throw new Error("Build identity has an invalid source commit");
  }
  if (typeof identity.sourceDirty !== "boolean") {
    throw new Error("Build identity has an invalid source-tree state");
  }
  if (typeof identity.buildTimestamp !== "string" || !isCanonicalTimestamp(identity.buildTimestamp)) {
    throw new Error("Build identity has an invalid build timestamp");
  }
  const provenance: PackagedBuildProvenance = {
    artifactTarget: identity.artifactTarget,
    sourceCommit: identity.sourceCommit,
    buildTimestamp: identity.buildTimestamp
  };
  if (identity.buildKind === "release") {
    if (identity.sourceDirty) throw new Error("A release build cannot claim a dirty source tree");
    return { ...common, ...provenance, buildKind: "release", sourceDirty: false };
  }
  return {
    ...common,
    ...provenance,
    buildKind: "development",
    sourceDirty: identity.sourceDirty,
  };
}

export function isBuildIdentity(value: unknown): value is BuildIdentity {
  try {
    parseBuildIdentity(value);
    return true;
  } catch {
    return false;
  }
}

export function sameBuildIdentity(left: BuildIdentity, right: BuildIdentity): boolean {
  return BUILD_IDENTITY_KEYS.every((key) => left[key] === right[key]);
}

export function formatBuildVersion(identity = AI_1667_BUILD_IDENTITY): string {
  if (identity.artifactTarget === "source") return `1667 ${identity.productVersion} (source)`;
  const dirty = identity.sourceDirty ? "-dirty" : "";
  return `1667 ${identity.productVersion} (${identity.buildKind}; ${identity.sourceCommit.slice(0, 12)}${dirty}; ${identity.artifactTarget})`;
}

function commonIdentity(productVersion: string): CommonBuildIdentity {
  return {
    schemaVersion: 1,
    product: AI_1667_PRODUCT,
    productVersion,
    apiProtocolVersion: HTTP_API_PROTOCOL_VERSION,
    minClientProtocolVersion: HTTP_MIN_CLIENT_PROTOCOL_VERSION,
    maxClientProtocolVersion: HTTP_MAX_CLIENT_PROTOCOL_VERSION
  };
}

function parseProtocolRange(identity: Record<string, unknown>): Pick<
  CommonBuildIdentity,
  "apiProtocolVersion" | "minClientProtocolVersion" | "maxClientProtocolVersion"
> {
  const apiProtocolVersion = protocolVersion(identity.apiProtocolVersion);
  const minClientProtocolVersion = protocolVersion(identity.minClientProtocolVersion);
  const maxClientProtocolVersion = protocolVersion(identity.maxClientProtocolVersion);
  if (minClientProtocolVersion > maxClientProtocolVersion
    || apiProtocolVersion < minClientProtocolVersion
    || apiProtocolVersion > maxClientProtocolVersion) {
    throw new Error("Build identity has an invalid API compatibility range");
  }
  return { apiProtocolVersion, minClientProtocolVersion, maxClientProtocolVersion };
}

function protocolVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Build identity has an invalid API protocol version");
  }
  return value;
}

function isPackagedArtifactTarget(value: unknown): value is PackagedArtifactTarget {
  return typeof value === "string"
    && (PACKAGED_ARTIFACT_TARGETS as readonly string[]).includes(value);
}

function isCanonicalTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

const injectedIdentity = typeof __AI_1667_BUILD_IDENTITY__ === "undefined"
  ? createSourceBuildIdentity()
  : parseBuildIdentity(__AI_1667_BUILD_IDENTITY__);

export const AI_1667_BUILD_IDENTITY: BuildIdentity = Object.freeze(injectedIdentity);
export const AI_1667_PRODUCT_VERSION = AI_1667_BUILD_IDENTITY.productVersion;
/** The running build in a corner's worth of cells. `formatBuildVersion` is the
 *  full identity; this is what fits beside the model in a status bar. */
export const AI_1667_VERSION_TAG = `v${AI_1667_PRODUCT_VERSION}`;
