import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initializeProject } from "../../server/project-discovery.js";
import { StoryService } from "../../server/story-service.js";
import { runCardImport } from "../src/card-import-cli.js";
import { runStoryImport } from "../src/import-cli.js";
import { createWorkerStoryApi } from "../src/worker-api.js";

const created: string[] = [];

afterEach(async () => {
  for (const directory of created.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

test("card import requires --story", async () => {
  const { root } = await projectWithStories(["Existing"]);
  expect(await failure(() => runCardImport(["--data", root], sink(), sink())))
    .toContain("import-card requires --story, because card Facts join a story that already exists");
});

test("both import commands refuse a flag as a flag value", async () => {
  expect(await failure(() => runCardImport(["--story", "--data"], sink(), sink())))
    .toContain("--story requires a value");
  expect(await failure(() => runStoryImport(["--data", "--global", "card.json"], sink(), sink())))
    .toContain("--data requires a value");
});

test("card import rejects an unknown story", async () => {
  const { root } = await projectWithStories(["Existing"]);
  const file = await cardFile(root);
  expect(await failure(() => runCardImport(
    ["--story", "missing", "--data", root, file],
    sink(),
    sink()
  ))).toContain("unknown story: missing");
});

test("card import selects a story by case-insensitive title", async () => {
  const { root, stories } = await projectWithStories(["Target Story"]);
  const file = await cardFile(root);
  const output = collector();

  await runCardImport(
    ["--story=target story", "--data", root, file],
    output.stream,
    sink()
  );

  expect(output.text()).toContain(
    `${file}: imported 1 fact for "Mira" into "Target Story" — used description, personality`
  );
  const service = StoryService.withoutDiagnostics({
    dataDir: path.join(root, ".1667")
  });
  await service.init();
  const payload = await service.loadStory(stories[0]!.id);
  await service.dispose();
  expect(payload.facts).toHaveLength(1);
  expect(payload.facts[0]!.tag).toBe("Character");
});

test("card import rejects an ambiguous title", async () => {
  const { root } = await projectWithStories(["Same Name", "Same Name"]);
  expect(await failure(() => runCardImport(
    ["--story", "Same Name", "--data", root, path.join(root, "unused.json")],
    sink(),
    sink()
  ))).toMatch(/more than one story has the name "Same Name"; use the story id \(/u);
});

test("card import reports a partial failure and keeps importing", async () => {
  const { root, stories } = await projectWithStories(["Partial target"]);
  const good = await cardFile(root);
  const missing = path.join(root, "missing.json");
  const output = collector();
  const errors = collector();

  const exitCode = await withExitCode(() => runCardImport(
    ["--story", stories[0]!.id, "--data", root, missing, good],
    output.stream,
    errors.stream
  ));

  expect(exitCode).toBe(1);
  expect(errors.text()).toContain("missing.json");
  expect(output.text()).toContain("imported 1 fact for");
});

async function projectWithStories(titles: readonly string[]): Promise<{
  readonly root: string;
  readonly stories: readonly { readonly id: string; readonly title: string }[];
}> {
  const root = await mkdtemp(path.join(tmpdir(), "1667-card-import-cli-"));
  created.push(root);
  await initializeProject(root);
  const seeded = await createWorkerStoryApi({ dataDir: path.join(root, ".1667") });
  try {
    for (const story of await seeded.api.listStories()) {
      await seeded.api.deleteStory(story.id);
    }
    const stories = [];
    for (const title of titles) {
      const story = await seeded.api.createStory(title);
      stories.push({ id: story.id, title: story.title });
    }
    return { root, stories };
  } finally {
    await seeded.dispose();
  }
}

async function cardFile(root: string): Promise<string> {
  const file = path.join(root, "mira.json");
  await writeFile(file, JSON.stringify({
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: {
      name: "Mira",
      description: "A cartographer.",
      personality: "Exacting but kind.",
      scenario: ""
    }
  }), "utf8");
  return file;
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

function sink(): { write: (text: string) => boolean } {
  return { write: () => true };
}

async function failure(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "the call resolved instead of failing";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function withExitCode(run: () => Promise<unknown>): Promise<number | string | undefined> {
  const before = process.exitCode ?? 0;
  process.exitCode = 0;
  try {
    await run();
    return process.exitCode;
  } finally {
    process.exitCode = before;
  }
}
