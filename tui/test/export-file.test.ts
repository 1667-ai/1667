import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { exportFileBase, writeStoryExport } from "../src/export-file.js";
import { parseExportCommand } from "../src/export-cli.js";
import { HELP } from "../src/main.js";

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
    expect(exportFileBase("*".repeat(400)).length).toBe(120);
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

describe("export help", () => {
  test("says which story it takes, which line, and every selector it accepts", () => {
    const block = HELP.slice(HELP.indexOf("Export:"), HELP.indexOf("Options:"));
    // The two questions the command cannot answer from its flags alone.
    expect(block).toContain("selected line");
    expect(block).toContain("most recently updated");
    // No flag picks a branch, so the help has to say where that choice lives.
    expect(block).toContain("choose it in the app first");
    // Usage must list every selector the parser honours, and only those.
    const usage = HELP.split("\n").find((line) => line.includes("1667 export"))!;
    for (const flag of ["--story", "--force", "--data", "--global"]) {
      expect(`${flag}:${usage.includes(flag)}`).toBe(`${flag}:true`);
    }
    // …and the parser must still honour the line the help advertises.
    expect(parseExportCommand(["--story=st1_abc", "--force", "--data=book"])).toEqual({
      storyId: "st1_abc",
      force: true,
      data: "book",
      global: false
    });
  });
});
