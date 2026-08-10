export interface SemVerIdentifier {
  readonly value: string;
  readonly numeric: boolean;
}

export interface SemVer {
  readonly raw: string;
  readonly major: string;
  readonly minor: string;
  readonly patch: string;
  readonly prerelease: readonly SemVerIdentifier[];
  readonly build: readonly string[];
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function parseSemVer(value: string): SemVer | null {
  const match = SEMVER.exec(value);
  if (match === null) return null;
  const prerelease = match[4] === undefined
    ? []
    : match[4].split(".").map((identifier) => Object.freeze({
      value: identifier,
      numeric: /^\d+$/.test(identifier)
    }));
  const build = match[5]?.split(".") ?? [];
  return Object.freeze({
    raw: value,
    major: match[1]!,
    minor: match[2]!,
    patch: match[3]!,
    prerelease: Object.freeze(prerelease),
    build: Object.freeze(build)
  });
}

export function isSemVer(value: unknown): value is string {
  return typeof value === "string" && parseSemVer(value) !== null;
}

export function compareSemVer(left: string, right: string): number {
  const parsedLeft = requireSemVer(left);
  const parsedRight = requireSemVer(right);
  for (const field of ["major", "minor", "patch"] as const) {
    const comparison = compareNumeric(parsedLeft[field], parsedRight[field]);
    if (comparison !== 0) return comparison;
  }
  if (parsedLeft.prerelease.length === 0) return parsedRight.prerelease.length === 0 ? 0 : 1;
  if (parsedRight.prerelease.length === 0) return -1;
  const count = Math.max(parsedLeft.prerelease.length, parsedRight.prerelease.length);
  for (let index = 0; index < count; index += 1) {
    const leftIdentifier = parsedLeft.prerelease[index];
    const rightIdentifier = parsedRight.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    const comparison = compareIdentifier(leftIdentifier, rightIdentifier);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

/** True when a channel head is an applicable upgrade from an exact version identity. */
export function isSemVerUpgradeAvailable(channelHead: string, currentVersion: string): boolean {
  return channelHead !== currentVersion && compareSemVer(channelHead, currentVersion) >= 0;
}

function requireSemVer(value: string): SemVer {
  const parsed = parseSemVer(value);
  if (parsed === null) throw new TypeError(`Invalid semantic version: ${value}`);
  return parsed;
}

function compareIdentifier(left: SemVerIdentifier, right: SemVerIdentifier): number {
  if (left.numeric && right.numeric) return compareNumeric(left.value, right.value);
  if (left.numeric !== right.numeric) return left.numeric ? -1 : 1;
  return left.value < right.value ? -1 : left.value > right.value ? 1 : 0;
}

function compareNumeric(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}
