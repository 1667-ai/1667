import { isSemVer, parseSemVer } from "../shared/semver.js";

/**
 * The one spelling of the nightly channel. The Installer file names, the
 * prerelease identifier and the release tag all read it from here, so a rename
 * cannot leave one of them behind.
 */
export const NIGHTLY_CHANNEL = "nightly" as const;

/**
 * The one Git tag the Nightly Release carries. It never changes, so the asset
 * URLs the Installers embed stay valid across runs and storage stays constant.
 */
export const NIGHTLY_RELEASE_TAG = NIGHTLY_CHANNEL;

/** Structured breakdown of a parsed nightly release version identifier. */
export interface NightlyVersion {
  readonly base: string;
  readonly date: string;
  readonly shortCommit: string;
}

/**
 * Formats a nightly release version string from a base version, timestamp, and commit.
 *
 * Nightly releases require a clean released base SemVer without pre-release or build metadata.
 * A 7-character commit prefix is used by default, but lengthened if leading zeros make it
 * an invalid numeric SemVer pre-release identifier.
 */
export function nightlyReleaseVersion(base: string, buildTimestamp: string, sourceCommit: string): string {
  if (!isSemVer(base)) throw new Error(`Nightly version needs a released base version, not ${base}`);
  const parsedBase = parseSemVer(base);
  if (parsedBase === null || parsedBase.prerelease.length > 0 || parsedBase.build.length > 0) {
    throw new Error(`Nightly version needs a released base version, not ${base}`);
  }

  if (typeof buildTimestamp !== "string" || !buildTimestamp.endsWith("Z")) {
    throw new Error(`Nightly version needs a UTC timestamp, not ${buildTimestamp}`);
  }
  const timestampDate = new Date(buildTimestamp);
  if (Number.isNaN(timestampDate.getTime())) {
    throw new Error(`Nightly version needs a UTC timestamp, not ${buildTimestamp}`);
  }

  const year = timestampDate.getUTCFullYear().toString().padStart(4, "0");
  const month = (timestampDate.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = timestampDate.getUTCDate().toString().padStart(2, "0");
  const date = `${year}${month}${day}`;

  if (typeof sourceCommit !== "string" || !/^[0-9a-f]{40}$/.test(sourceCommit)) {
    throw new Error(`Nightly version needs a full commit id, not ${sourceCommit}`);
  }

  // Seven characters, unless SemVer refuses them. SemVer reads an all-digit
  // identifier as a number and forbids a leading zero, so a commit such as
  // 0123456… would produce a version nothing in this repository can parse.
  // About one commit in three hundred starts that way, so grow the prefix until
  // it holds a letter or drops the leading zero rather than fail a nightly run.
  let shortCommit = "";
  for (let len = 7; len <= 40; len += 1) {
    const prefix = sourceCommit.slice(0, len);
    if (/^\d+$/.test(prefix) && prefix.startsWith("0")) continue;
    shortCommit = prefix;
    break;
  }
  if (shortCommit === "") {
    throw new Error(
      `Nightly version needs a commit SemVer accepts, not ${sourceCommit}`
    );
  }

  const version = `${base}-${NIGHTLY_CHANNEL}.${date}.${shortCommit}`;
  if (!isSemVer(version)) throw new Error(`Generated nightly version is invalid SemVer: ${version}`);
  return version;
}

/**
 * Parses a nightly release version string into its constituent components.
 *
 * Returns null if the version string is not a valid SemVer or does not conform to the
 * required nightly pre-release format (nightly.<8-digit-date>.<short-commit>).
 */
export function parseNightlyVersion(version: string): NightlyVersion | null {
  if (typeof version !== "string") return null;
  const parsed = parseSemVer(version);
  if (parsed === null || parsed.build.length > 0 || parsed.prerelease.length !== 3) return null;
  if (parsed.prerelease[0]!.value !== NIGHTLY_CHANNEL) return null;
  const date = parsed.prerelease[1]!.value;
  if (!/^\d{8}$/.test(date)) return null;
  const shortCommit = parsed.prerelease[2]!.value;
  if (!/^[0-9a-f]{7,40}$/.test(shortCommit)) return null;
  return Object.freeze({
    base: `${parsed.major}.${parsed.minor}.${parsed.patch}`,
    date,
    shortCommit
  });
}

/** Checks whether a given version string is a valid nightly release version. */
export function isNightlyVersion(version: string): boolean {
  return parseNightlyVersion(version) !== null;
}

/** Decision returned when evaluating whether to trigger a new nightly release build. */
export type NightlyRunDecision =
  | { readonly kind: "build" }
  | { readonly kind: "skip"; readonly reason: string };

/**
 * Determines whether a nightly build should proceed based on head and previous commits.
 *
 * If head matches the commit of the previous nightly release, the build is skipped
 * to avoid producing redundant nightly artifacts when no new commits have landed.
 */
export function nightlyRunDecision(headCommit: string, previousCommit: string | null): NightlyRunDecision {
  if (typeof headCommit !== "string" || !/^[0-9a-f]{40}$/.test(headCommit)) {
    throw new Error(`Nightly run needs a full commit id, not ${headCommit}`);
  }
  if (previousCommit !== null) {
    if (typeof previousCommit !== "string" || !/^[0-9a-f]{40}$/.test(previousCommit)) {
      throw new Error(`Nightly run needs a full commit id, not ${previousCommit}`);
    }
    if (headCommit === previousCommit) {
      return Object.freeze({
        kind: "skip" as const,
        reason: `No commit landed after the last Nightly Release at ${previousCommit}`
      });
    }
  }
  return Object.freeze({ kind: "build" as const });
}
