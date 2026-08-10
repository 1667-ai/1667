import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { RELEASE_NOTES } from "../../shared/release-notes.js";
import { compareSemVer } from "../../shared/semver.js";

const CHANGELOG_FILE = fileURLToPath(new URL("../../CHANGELOG.md", import.meta.url));

// This exercises the real generated artifact against the real CHANGELOG.md,
// not a fixture: it is the codegen pipeline `npm run notes:write` runs,
// caught the moment the two would disagree.
describe("release notes codegen", () => {
  test("excludes Unreleased and includes the known released versions", () => {
    const versions = RELEASE_NOTES.map((note) => note.version);
    expect(versions).not.toContain("Unreleased");
    expect(versions).toContain("0.2.1");
    expect(versions).toContain("0.1.2");
  });

  test("is strictly newest-first across the whole array, with no duplicate version", () => {
    // A hardcoded pair of versions would pass even if a future insert landed
    // in the wrong place elsewhere in the list. Check every adjacent pair.
    for (let index = 1; index < RELEASE_NOTES.length; index += 1) {
      const previous = RELEASE_NOTES[index - 1]!;
      const current = RELEASE_NOTES[index]!;
      expect(compareSemVer(current.version, previous.version)).toBeLessThan(0);
    }
  });

  test("one entry exists for every released heading in CHANGELOG.md", async () => {
    const changelog = await readFile(CHANGELOG_FILE, "utf8");
    const releasedHeadings = changelog
      .split("\n")
      .filter((line) => line.startsWith("## ") && line.trim() !== "## Unreleased");

    expect(RELEASE_NOTES.length).toBe(releasedHeadings.length);
  });

  test("each note's heading text matches CHANGELOG.md exactly", async () => {
    const changelog = await readFile(CHANGELOG_FILE, "utf8");
    for (const note of RELEASE_NOTES) {
      expect(changelog).toContain(`## ${note.version} - ${note.date}`);
    }
  });
});
