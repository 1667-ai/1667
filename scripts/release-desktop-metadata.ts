import { parseSemVer } from "../shared/semver.js";

export type DesktopMetadataTarget =
  | "darwin-arm64"
  | "darwin-x64"
  | "linux-arm64"
  | "linux-x64"
  | "windows-x64";

/** All prereleases use the product's beta channel. */
export function desktopReleaseChannel(version: string): "latest" | "beta" {
  return parseDesktopVersion(version).prerelease.length === 0 ? "latest" : "beta";
}

/** The target-specific metadata name retained in the GitHub release. */
export function desktopMetadataName(
  version: string,
  target: DesktopMetadataTarget
): string {
  const channel = desktopReleaseChannel(version);
  return `${channel}-${target}.yml`;
}

/** Keep this alias for callers that verify one matrix target at a time. */
export function stagedDesktopMetadataName(
  version: string,
  target: DesktopMetadataTarget
): string {
  return desktopMetadataName(version, target);
}

/** Metadata files electron-builder may emit beside the selected channel. */
export function desktopMetadataCandidates(
  version: string,
  target: DesktopMetadataTarget
): readonly string[] {
  // Builder names its raw metadata after the first prerelease identifier.
  // Staging maps that file onto the product's stable or beta feed.
  const channel = parseDesktopVersion(version).prerelease[0]?.value ?? "latest";
  const channels = new Set([channel, "latest", "alpha", "beta"]);
  return Object.freeze([...channels].map((candidate) => `${candidate}${metadataSuffix(target)}.yml`));
}

/** Rewrite generated metadata to use the normalized archive and absolute URL. */
export function rewriteDesktopMetadata(
  source: string,
  archiveSource: string,
  archiveName: string,
  blockmapSource: string | null,
  blockmapName: string,
  archiveUrl: string,
  target: DesktopMetadataTarget
): string {
  let body = source.replaceAll(archiveSource, archiveName);
  if (blockmapSource !== null) body = body.replaceAll(blockmapSource, blockmapName);
  const urlLine = new RegExp(
    `^(\\s*(?:-\\s*)?url:\\s*)(["']?)${escapeRegExp(archiveName)}(["']?)(\\s*)$`,
    "gmu"
  );
  body = body.replace(urlLine, `$1$2${archiveUrl}$3$4`);
  if (!body.includes(`url: ${archiveUrl}`) || !body.includes(`path: ${archiveName}`)) {
    throw new Error(`Desktop metadata for ${target} does not name its normalized archive`);
  }
  return body;
}

/**
 * Merge Mac metadata from two target-specific release assets.
 *
 * The homepage uses this helper when it publishes the generic feed file that
 * electron-updater requests. GitHub release assets stay target-specific.
 */
export function mergeMacDesktopMetadata(
  version: string,
  arm64: string,
  x64: string
): string {
  const arm = splitMetadata(arm64, version, "darwin-arm64");
  const intel = splitMetadata(x64, version, "darwin-x64");
  const seen = new Set<string>();
  const entries = [...intel.entries, ...arm.entries].filter((entry) => {
    const url = entry.match(/^\s*-\s*url:\s*(\S+)/mu)?.[1];
    if (url === undefined || seen.has(url)) return false;
    seen.add(url);
    return true;
  });
  if (entries.length !== intel.entries.length + arm.entries.length) {
    throw new Error("Mac desktop metadata repeats an archive URL");
  }
  return [intel.header, "files:", ...entries, intel.footer, ""].join("\n");
}

interface SplitMetadata {
  readonly header: string;
  readonly entries: readonly string[];
  readonly footer: string;
}

function splitMetadata(
  body: string,
  version: string,
  target: DesktopMetadataTarget
): SplitMetadata {
  if (!body.includes(`version: ${version}`)) {
    throw new Error(`Desktop metadata for ${target} has the wrong version`);
  }
  const lines = body.trimEnd().split("\n");
  const filesIndex = lines.indexOf("files:");
  const footerIndex = lines.findIndex((line, index) => index > filesIndex && /^path:\s/u.test(line));
  if (filesIndex < 1 || footerIndex <= filesIndex) {
    throw new Error(`Desktop metadata for ${target} has an invalid file list`);
  }
  const entries: string[] = [];
  let current: string[] = [];
  for (const line of lines.slice(filesIndex + 1, footerIndex)) {
    if (/^\s*-\s*url:\s/u.test(line) && current.length > 0) {
      entries.push(current.join("\n"));
      current = [];
    }
    if (line.trim().length > 0) current.push(line);
  }
  if (current.length > 0) entries.push(current.join("\n"));
  if (entries.length === 0) throw new Error(`Desktop metadata for ${target} has no files`);
  return Object.freeze({
    header: lines.slice(0, filesIndex).join("\n"),
    entries: Object.freeze(entries),
    footer: lines.slice(footerIndex).join("\n")
  });
}

function metadataSuffix(target: DesktopMetadataTarget): string {
  if (target === "darwin-arm64" || target === "darwin-x64") return "-mac";
  if (target === "linux-arm64") return "-linux-arm64";
  if (target === "linux-x64") return "-linux";
  return "";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function parseDesktopVersion(version: string) {
  const parsed = parseSemVer(version);
  if (parsed === null) throw new Error(`Desktop release version is not SemVer: ${version}`);
  return parsed;
}
