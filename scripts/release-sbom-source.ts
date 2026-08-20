import { isCanonicalTimestamp } from "../shared/build-identity.js";
import { isSemVer } from "../shared/semver.js";
import { exactRecord } from "./release-boundary-validation.js";

const SOURCE_KEYS = new Set([
  "productVersion",
  "sourceCommit",
  "buildTimestamp",
  "tagName",
  "noticeText"
]);
const SOURCE_COMMIT = /^[0-9a-f]{40}$/u;
const MAX_NOTICE_BYTES = 1024 * 1024;

/**
 * The source facts that an SBOM describes. This record contains no release
 * authorization claim.
 */
export interface ReleaseSbomSource {
  readonly productVersion: string;
  readonly sourceCommit: string;
  readonly buildTimestamp: string;
  readonly tagName: string;
  /** Exact current repository NOTICE text for SPDX attribution. */
  readonly noticeText: string;
}

/**
 * Accepts only the source facts that an SBOM uses. The exact record check
 * rejects a full release evidence document instead of silently discarding its
 * tag authorization fields.
 */
export function createReleaseSbomSource(value: unknown): ReleaseSbomSource {
  const input = exactRecord(value, SOURCE_KEYS, "Release SBOM source");
  const productVersion = stringField(input.productVersion, "productVersion");
  const sourceCommit = stringField(input.sourceCommit, "sourceCommit");
  const buildTimestamp = stringField(input.buildTimestamp, "buildTimestamp");
  const tagName = stringField(input.tagName, "tagName");
  const noticeText = stringField(input.noticeText, "noticeText");

  if (!isSemVer(productVersion)) {
    throw new Error("Release SBOM source has an invalid product version");
  }
  if (!SOURCE_COMMIT.test(sourceCommit)) {
    throw new Error("Release SBOM source has an invalid source commit");
  }
  if (!isCanonicalTimestamp(buildTimestamp)) {
    throw new Error("Release SBOM source has an invalid build timestamp");
  }
  if (tagName !== `v${productVersion}`) {
    throw new Error("Release SBOM source tag does not match its product version");
  }
  if (Buffer.byteLength(noticeText, "utf8") > MAX_NOTICE_BYTES) {
    throw new Error("Release SBOM source NOTICE exceeds its size bound");
  }

  return Object.freeze({ productVersion, sourceCommit, buildTimestamp, tagName, noticeText });
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Release SBOM source ${label} must be a non-empty string`);
  }
  return value;
}
