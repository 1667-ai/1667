import { describe, expect, test } from "bun:test";
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initializeProject } from "../../server/project-discovery.js";
import {
  createExportFileAllocator,
  exportFileBase,
  writeExportFile,
  writeStoryExport
} from "../src/export-file.js";
import { parseExportCommand, runStoryExport } from "../src/export-cli.js";
import { HELP } from "../src/main.js";
import { createWorkerStoryApi } from "../src/worker-api.js";

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

  test("--force replaces a symlink without writing through it", async () => {
    if (process.platform === "win32") return;
    const directory = await temporaryDirectory();
    try {
      const outside = path.join(directory, "outside.txt");
      const exported = path.join(directory, "Archive.story");
      await writeFile(outside, "outside");
      await symlink(outside, exported);

      const result = await writeExportFile({
        directory,
        title: "Archive",
        extension: ".story",
        content: "replacement",
        force: true
      });

      expect(result).toBe(exported);
      expect((await lstat(exported)).isSymbolicLink()).toBeFalse();
      expect(await readFile(exported, "utf8")).toBe("replacement");
      expect(await readFile(outside, "utf8")).toBe("outside");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("a title becomes a safe bounded filename", () => {
    expect(exportFileBase("Chapter 1: The/Door\\Home")).toBe("Chapter 1- The-Door-Home");
    expect(exportFileBase("   ")).toBe("story");
    expect(exportFileBase("\u0000title\u001f. ")).toBe("-title-");
    expect(exportFileBase("*".repeat(400)).length).toBe(120);
    expect(new TextEncoder().encode(exportFileBase("😀".repeat(400))).length).toBe(120);
    expect(exportFileBase("CON.txt")).toBe("_CON.txt");
  });

  test("writes fixed archive extensions and keeps suffix-colliding forced batch names separate", async () => {
    const directory = await temporaryDirectory();
    try {
      const names = createExportFileAllocator();
      const first = await writeExportFile({
        directory,
        title: "Archive",
        extension: ".story",
        content: "first",
        force: true,
        collisionIndex: names.allocate("Archive", ".story")
      });
      const duplicate = await writeExportFile({
        directory,
        title: "Archive",
        extension: ".story",
        content: "duplicate",
        force: true,
        collisionIndex: names.allocate("Archive", ".story")
      });
      const suffixTitle = await writeExportFile({
        directory,
        title: "Archive-2",
        extension: ".story",
        content: "suffix title",
        force: true,
        collisionIndex: names.allocate("Archive-2", ".story")
      });
      expect(path.basename(first)).toBe("Archive.story");
      expect(path.basename(duplicate)).toBe("Archive-2.story");
      expect(path.basename(suffixTitle)).toBe("Archive-2-2.story");
      expect(await readFile(first, "utf8")).toBe("first");
      expect(await readFile(duplicate, "utf8")).toBe("duplicate");
      expect(await readFile(suffixTitle, "utf8")).toBe("suffix title");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("reserves batch names as a case- and normalization-insensitive filesystem does", () => {
    const names = createExportFileAllocator();
    expect(names.allocate("Archive", ".story")).toBe(1);
    expect(names.allocate("archive", ".story")).toBe(2);
    expect(names.allocate("Cafe\u0301", ".story")).toBe(1);
    expect(names.allocate("CAFÉ", ".story")).toBe(2);
  });
});

describe("export command line", () => {
  test("reads the story, archive format, batch selector, force flag, and project selector", () => {
    expect(parseExportCommand([])).toEqual({
      storyId: null,
      all: false,
      format: "markdown",
      force: false,
      data: null,
      global: false
    });
    expect(parseExportCommand(["--story", "st1_abc", "--force"])).toMatchObject({
      storyId: "st1_abc",
      force: true
    });
    expect(parseExportCommand(["--story=st1_abc", "--format", "story", "--data=book"])).toMatchObject({
      storyId: "st1_abc",
      format: "story",
      data: "book"
    });
    expect(parseExportCommand(["--all", "--format=scenario"])).toMatchObject({
      all: true,
      format: "scenario"
    });
    expect(parseExportCommand(["--format=lorebook"])).toMatchObject({ format: "lorebook" });
    expect(() => parseExportCommand(["--story"])).toThrow("--story requires a value");
    expect(() => parseExportCommand(["--format"])).toThrow("--format requires a value");
    expect(() => parseExportCommand(["--format", "pdf"])).toThrow("unknown export format: pdf");
    expect(() => parseExportCommand(["--format=pdf"])).toThrow("unknown export format: pdf");
    expect(() => parseExportCommand(["--story", "st1_abc", "--all"])).toThrow("select different stories");
    expect(() => parseExportCommand(["--story", "--all"])).toThrow("--story requires a value");
    expect(() => parseExportCommand(["--nope"])).toThrow("unknown export option: --nope");
    expect(() => parseExportCommand(["--output", "book.md"]))
      .toThrow("unknown export option: --output");
    expect(() => parseExportCommand(["--global", "--data", "book"]))
      .toThrow("select different projects");
  });
});

async function temporaryDirectory(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "1667-export-"));
}

function collector(): {
  readonly stream: { write: (text: string) => boolean };
  readonly text: () => string;
} {
  const parts: string[] = [];
  return {
    stream: { write: (text) => { parts.push(String(text)); return true; } },
    text: () => parts.join("")
  };
}

describe("export command", () => {
  test("runs against a project worker and gives duplicate bulk titles separate files", async () => {
    const root = await temporaryDirectory();
    await initializeProject(root);
    const seeded = await createWorkerStoryApi({ dataDir: path.join(root, ".1667") });
    try {
      for (const story of await seeded.api.listStories()) {
        await seeded.api.deleteStory(story.id);
      }
      await seeded.api.createStory("A Door: North");
      await seeded.api.createStory("A Door? North");
    } finally {
      await seeded.dispose();
    }

    const output = collector();
    const errors = collector();
    try {
      await runStoryExport(["--all", "--force", "--data", root], output.stream, errors.stream);
      const files = output.text().trimEnd().split("\n");
      expect(files).toHaveLength(2);
      expect(files.map((file) => path.basename(file)).sort()).toEqual([
        "A Door- North-2.md",
        "A Door- North.md"
      ]);
      for (const file of files) {
        expect(path.isAbsolute(file)).toBeTrue();
        expect(await readFile(file, "utf8")).toContain("# A Door");
      }
      expect(errors.text()).toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("writes an archive through a project worker and reports its fidelity", async () => {
    const root = await temporaryDirectory();
    await initializeProject(root);
    const seeded = await createWorkerStoryApi({ dataDir: path.join(root, ".1667") });
    let storyId: string;
    try {
      for (const story of await seeded.api.listStories()) {
        await seeded.api.deleteStory(story.id);
      }
      let story = await seeded.api.createStory("Archive output");
      story = await seeded.api.createNode(story.id, {
        parentId: null,
        instruction: "Open under the lantern.",
        text: "The lantern lit the path."
      });
      story = await seeded.api.createFact(story.id, {
        tag: "Place",
        text: "The path runs north."
      });
      storyId = story.id;
    } finally {
      await seeded.dispose();
    }

    const output = collector();
    const errors = collector();
    try {
      await runStoryExport([
        "--story", storyId, "--format", "scenario", "--data", root
      ], output.stream, errors.stream);
      const file = output.text().trim();
      expect(path.basename(file)).toBe("Archive output.scenario");
      const archive = JSON.parse(await readFile(file, "utf8"));
      expect(archive.scenarioVersion).toBe(3);
      expect(archive.prompt).toBe("The lantern lit the path.");
      expect(archive.lorebook.entries).toHaveLength(1);
      expect(errors.text()).toContain(file);
      expect(errors.text()).not.toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

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
    for (const flag of ["--story", "--all", "--format", "--force", "--data", "--global"]) {
      expect(`${flag}:${usage.includes(flag)}`).toBe(`${flag}:true`);
    }
    // …and the parser must still honour the line the help advertises.
    expect(parseExportCommand(["--story=st1_abc", "--force", "--data=book"])).toEqual({
      storyId: "st1_abc",
      all: false,
      format: "markdown",
      force: true,
      data: "book",
      global: false
    });
  });
});
