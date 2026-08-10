import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { RELEASE_NOTES } from "../../shared/release-notes.js";

const CHANGELOG_FILE = fileURLToPath(new URL("../../CHANGELOG.md", import.meta.url));

// This exercises the real generated artifact against the real CHANGELOG.md,
// not a fixture: it is the codegen pipeline `npm run notes:write` runs,
// caught the moment the two would disagree.
describe("release notes codegen", () => {
  test("excludes Unreleased and includes the known released versions, newest first", () => {
    const versions = RELEASE_NOTES.map((note) => note.version);
    expect(versions).not.toContain("Unreleased");
    expect(versions).toContain("0.2.1");
    expect(versions).toContain("0.1.2");
    // CHANGELOG.md lists 0.2.1 above 0.1.2, and the embedded list must agree.
    expect(versions.indexOf("0.2.1")).toBeLessThan(versions.indexOf("0.1.2"));
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
