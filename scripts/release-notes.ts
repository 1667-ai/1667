import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareSemVer, isSemVer } from "../shared/semver.js";
import { assertExact } from "./generated-artifact.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHANGELOG_FILE = path.join(ROOT, "CHANGELOG.md");
const OUTPUT_FILE = path.join(ROOT, "shared", "release-notes.ts");
const ARTIFACT_OPTIONS = { root: ROOT, label: "release notes", writeCommand: "npm run notes:write" };

export interface ParsedReleaseNote {
  readonly version: string;
  readonly date: string;
  readonly body: string;
}

// A release heading reads "<semver> - <YYYY-MM-DD>". A prerelease version
// such as "0.6.0-rc.1" has no space around its own hyphen, so the single
// " - " separator below stays unambiguous.
const RELEASE_HEADING = /^(.+) - (\d{4}-\d{2}-\d{2})$/;

interface HeadingNote {
  readonly note: ParsedReleaseNote;
  readonly lineNumber: number;
}

/**
 * Parse every released section of `CHANGELOG.md`. A `## Unreleased` section
 * is not a release, and is skipped. Every other `## ` heading must read as
 * `<semver> - <YYYY-MM-DD>`, with a real calendar date, or the changelog is
 * malformed: this throws rather than silently dropping the section, so a bad
 * heading fails the build instead of shipping a binary with a gap in its own
 * history.
 *
 * Sections must already be newest first in the file, with no duplicate
 * version. Both are asserted, not assumed: the notes ship inside the binary
 * in file order, so a misordered or duplicated heading would otherwise ship
 * silently.
 */
export function parseReleaseNotes(changelog: string): ParsedReleaseNote[] {
  const lines = changelog.split("\n");
  const headingLines: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]!.startsWith("## ")) headingLines.push(index);
  }
  const collected: HeadingNote[] = [];
  for (let cursor = 0; cursor < headingLines.length; cursor += 1) {
    const lineIndex = headingLines[cursor]!;
    const title = lines[lineIndex]!.slice(3).trim();
    const bodyStart = lineIndex + 1;
    const bodyEnd = cursor + 1 < headingLines.length ? headingLines[cursor + 1]! : lines.length;
    if (title === "Unreleased") continue;
    const match = RELEASE_HEADING.exec(title);
    if (match === null || !isSemVer(match[1]!) || !isValidReleaseDate(match[2]!)) {
      throw new Error(
        `CHANGELOG.md line ${lineIndex + 1} has a release heading 1667 cannot parse: `
        + `"## ${title}". A release heading must read "## <semver> - <YYYY-MM-DD>", `
        + `for example "## 0.2.1 - 2026-08-01".`
      );
    }
    const body = trimBlankLines(lines.slice(bodyStart, bodyEnd)).join("\n");
    collected.push({ note: { version: match[1]!, date: match[2]!, body }, lineNumber: lineIndex + 1 });
  }
  assertNewestFirstWithNoDuplicates(collected);
  return collected.map((entry) => entry.note);
}

function assertNewestFirstWithNoDuplicates(collected: readonly HeadingNote[]): void {
  for (let index = 1; index < collected.length; index += 1) {
    const previous = collected[index - 1]!;
    const current = collected[index]!;
    const comparison = compareSemVer(current.note.version, previous.note.version);
    if (comparison === 0) {
      throw new Error(
        `CHANGELOG.md has two release headings for version ${current.note.version}: `
        + `line ${previous.lineNumber} and line ${current.lineNumber}. Each released version `
        + "must have exactly one section."
      );
    }
    if (comparison > 0) {
      throw new Error(
        `CHANGELOG.md is not newest-first: "## ${previous.note.version} - ${previous.note.date}" `
        + `(line ${previous.lineNumber}) sits above "## ${current.note.version} - ${current.note.date}" `
        + `(line ${current.lineNumber}), which is a newer version. Sort release sections newest to oldest.`
      );
    }
  }
}

/** Round-trip check, the same shape as `isCanonicalTimestamp` in
 *  shared/build-identity.ts: the shape test alone admits an impossible date
 *  such as `2026-13-45`, or a day that quietly rolls into the next month,
 *  such as `2026-02-30`. */
function isValidReleaseDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function trimBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim().length === 0) start += 1;
  while (end > start && lines[end - 1]!.trim().length === 0) end -= 1;
  return lines.slice(start, end);
}

function generatedSource(notes: ParsedReleaseNote[]): string {
  const entries = notes.map((note) => [
    "  {",
    `    version: ${JSON.stringify(note.version)},`,
    `    date: ${JSON.stringify(note.date)},`,
    `    body: ${JSON.stringify(note.body)}`,
    "  }"
  ].join("\n"));
  const list = entries.length === 0 ? "[]" : `[\n${entries.join(",\n")}\n]`;
  return [
    "// GENERATED FILE. Source: CHANGELOG.md.",
    "// Run `npm run notes:write` to regenerate. Do not edit this file by hand.",
    "",
    "export interface ReleaseNote {",
    "  readonly version: string;",
    "  readonly date: string;",
    "  readonly body: string;",
    "}",
    "",
    "/** Every released CHANGELOG.md section, newest first. `Unreleased` is not",
    " *  a release, and is not included. */",
    `export const RELEASE_NOTES: readonly ReleaseNote[] = ${list};`,
    ""
  ].join("\n");
}

/**
 * Fail unless `notes` has a release entry for exactly `version`. Distinct
 * from the artifact-staleness check `assertExact` performs below: a missing
 * `CHANGELOG.md` section and a stale generated file are different mistakes
 * with different fixes, so each throws its own message naming which one
 * happened. `notes:check` alone cannot catch a missing section — it only
 * verifies the generated file matches whatever headings already exist, and
 * passes happily when the version being published is still sitting under
 * `## Unreleased` with no section of its own. A tagged binary can then ship
 * with no note for its own version — and because the "unknown previous
 * version" upgrade path (see `release-announcement.ts`) matches a note by
 * exact version, every pre-feature installation upgrading to that release
 * gets nothing, and is stamped as seen regardless: its one chance to be told
 * is gone for good.
 */
function assertVersionHasReleaseNote(notes: readonly ParsedReleaseNote[], version: string): void {
  if (notes.some((note) => note.version === version)) return;
  throw new Error(
    `CHANGELOG.md has no release section for ${version}. Add "## ${version} - <YYYY-MM-DD>" `
    + "to CHANGELOG.md, then run npm run notes:write, before publishing this version."
  );
}

const mode = process.argv[2];
if (mode === "--write") {
  const changelog = await readFile(CHANGELOG_FILE, "utf8");
  const notes = parseReleaseNotes(changelog);
  await writeFile(OUTPUT_FILE, generatedSource(notes));
} else if (mode === "--check") {
  const changelog = await readFile(CHANGELOG_FILE, "utf8");
  const notes = parseReleaseNotes(changelog);
  await assertExact(OUTPUT_FILE, generatedSource(notes), ARTIFACT_OPTIONS);
} else if (mode === "--check-version") {
  // Both guarantees live in one gate on purpose (see the P1 this fixed):
  // wiring "the version has a section" and "the artifact is current" as two
  // separate workflow steps let a future edit drop one without the other.
  // A single mode that always runs both cannot be partially wired.
  const version = process.argv[3];
  if (version === undefined) {
    throw new Error("Usage: tsx scripts/release-notes.ts --check-version <version>");
  }
  const changelog = await readFile(CHANGELOG_FILE, "utf8");
  const notes = parseReleaseNotes(changelog);
  assertVersionHasReleaseNote(notes, version);
  await assertExact(OUTPUT_FILE, generatedSource(notes), ARTIFACT_OPTIONS);
} else {
  throw new Error("Usage: tsx scripts/release-notes.ts --write|--check|--check-version <version>");
}
