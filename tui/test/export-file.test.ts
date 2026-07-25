import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { exportFileBase, writeStoryExport } from "../src/export-file.js";
import { parseExportCommand } from "../src/export-cli.js";

describe("markdown export files", () => {
  test("a collision picks the next free name, and --force overwrites", async () => {
    const directory = await temporaryDirectory();
    try {
      const first = await writeStoryExport({
        directory,
        title: "A Door in the Hedge",
        markdown: "# first\n"
      });
      const second = await writeStoryExport({
        directory,
        title: "A Door in the Hedge",
        markdown: "# second\n"
      });
      expect(path.basename(first)).toBe("A Door in the Hedge.md");
      expect(path.basename(second)).toBe("A Door in the Hedge-2.md");
      expect(await readFile(first, "utf8")).toBe("# first\n");

      const forced = await writeStoryExport({
        directory,
        title: "A Door in the Hedge",
        markdown: "# forced\n",
        force: true
      });
      expect(forced).toBe(first);
      expect(await readFile(first, "utf8")).toBe("# forced\n");
      expect((await readdir(directory)).sort()).toEqual([
        "A Door in the Hedge-2.md",
        "A Door in the Hedge.md"
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("a title becomes a safe bounded filename", () => {
    expect(exportFileBase("Chapter 1: The/Door\\Home")).toBe("Chapter 1- The-Door-Home");
    expect(exportFileBase("   ")).toBe("story");
    expect(exportFileBase("*".repeat(400)).length).toBeLessThanOrEqual(120);
  });
});

describe("export command line", () => {
  test("reads the story, the force flag, and the project selector", () => {
    expect(parseExportCommand([])).toEqual({
      storyId: null,
      force: false,
      data: null,
      global: false
    });
    expect(parseExportCommand(["--story", "st1_abc", "--force"])).toMatchObject({
      storyId: "st1_abc",
      force: true
    });
    expect(parseExportCommand(["--story=st1_abc", "--data=book"])).toMatchObject({
      storyId: "st1_abc",
      data: "book"
    });
    expect(() => parseExportCommand(["--story"])).toThrow("--story requires a value");
    expect(() => parseExportCommand(["--nope"])).toThrow("unknown export option: --nope");
    expect(() => parseExportCommand(["--global", "--data", "book"]))
      .toThrow("select different projects");
  });
});

async function temporaryDirectory(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "1667-export-"));
}
