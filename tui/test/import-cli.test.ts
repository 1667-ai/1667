import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initializeProject } from "../../server/project-discovery.js";
import { StoryService } from "../../server/story-service.js";
import {
  novelAiLorebook,
  novelAiScenario,
  novelAiStoryContainer
} from "../../test/novelai-container-fixture.js";
import { runStoryImport } from "../src/import-cli.js";

/** A SillyTavern export: one metadata line, then one line per message. The
 * message fields are the snake_case ones the parser actually reads. */
const CHAT = [
  JSON.stringify({ user_name: "Maren", character_name: "Ashe" }),
  JSON.stringify({ mes: "The lantern went dark.", is_user: false, name: "Ashe", send_date: 0 }),
  JSON.stringify({ mes: "Ask him why.", is_user: true, name: "Maren", send_date: 1 }),
  JSON.stringify({ mes: "He would not say.", is_user: false, name: "Ashe", send_date: 2 })
].join("\n");

const created: string[] = [];
afterEach(async () => {
  for (const directory of created.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

test("import refuses a directory that is not a project rather than making one", async () => {
  const root = await project(false);
  const file = path.join(root, "chat.jsonl");
  await writeFile(file, CHAT, "utf8");

  // Importing into a directory with no project would create one, import into
  // it, and leave the starter stories it had just invented beside the result.
  expect(await failure(() => runStoryImport(
    [file, "--data", root],
    sink(),
    sink()
  ))).toMatch(/not a 1667 story project yet/u);
});

test("import reads a SillyTavern chat into one new story", async () => {
  const root = await project(true);
  const file = path.join(root, "chat.jsonl");
  await writeFile(file, CHAT, "utf8");
  const out = collector();

  await withExitCode(() => runStoryImport([file, "--data", root], out.stream, sink()));

  // Two character messages become two story parts; the user message between
  // them becomes the direction for the second, not a part of its own.
  expect(out.text()).toMatch(/imported "Ashe \(imported\)" \(2 parts\) as /u);
});

test("one unreadable file does not stop the others, and the batch still fails", async () => {
  const root = await project(true);
  const good = path.join(root, "good.jsonl");
  await writeFile(good, CHAT, "utf8");
  const missing = path.join(root, "missing.jsonl");
  const out = collector();
  const errors = collector();

  const exitCode = await withExitCode(() => runStoryImport(
    [missing, good, "--data", root],
    out.stream,
    errors.stream
  ));

  // The reachable file still became a story. A failure is reported, not fatal.
  expect(exitCode).toBe(1);
  expect(out.text()).toMatch(/imported "/u);
  expect(errors.text()).toMatch(/missing\.jsonl/u);
});

test("import creates a complete story from a NovelAI Container", async () => {
  const root = await project(true);
  const file = path.join(root, "complete.story");
  await writeFile(file, novelAiStoryContainer({
    title: "Complete Container",
    prose: ["First imported part.", "Second imported part."],
    context: {
      memory: "The harbor freezes in winter.",
      authorsNote: "Keep the scene quiet."
    },
    lorebook: novelAiLorebook(2)
  }), "utf8");
  const out = collector();
  const errors = collector();

  await withExitCode(() => runStoryImport(
    [file, "--data", root],
    out.stream,
    errors.stream
  ));

  expect(out.text()).toContain('imported "Complete Container" (2 parts, 3 facts) as ');
  expect(errors.text()).toStartWith(`${file}: `);
  const story = await loadImportedStory(root, "Complete Container");
  expect(story.path.map(({ text }) => text)).toEqual([
    "First imported part.",
    "Second imported part."
  ]);
  expect(story.facts.map(({ tag }) => tag)).toEqual(["memory", "Lore 1", "Lore 2"]);
  expect(story.authorsNote).toBe("Keep the scene quiet.");
});

test("import creates a complete story from a NovelAI Scenario", async () => {
  const root = await project(true);
  const file = path.join(root, "complete.scenario");
  await writeFile(file, novelAiScenario({
    title: "Complete Scenario",
    prompt: "# ${traveler} waits.\nThe marker is prose.\n\nThe gate opens.",
    context: {
      memory: "The traveler carries a brass key.",
      authorsNote: "Use short sentences."
    },
    lorebook: novelAiLorebook(1)
  }), "utf8");
  const out = collector();
  const errors = collector();

  await withExitCode(() => runStoryImport(
    [file, "--data", root],
    out.stream,
    errors.stream
  ));

  expect(out.text()).toContain('imported "Complete Scenario" (2 parts, 2 facts) as ');
  expect(errors.text()).toStartWith(`${file}: `);
  const story = await loadImportedStory(root, "Complete Scenario");
  expect(story.path.map(({ text }) => text)).toEqual([
    "# ${traveler} waits.\nThe marker is prose.",
    "The gate opens."
  ]);
  expect(story.facts.map(({ tag }) => tag)).toEqual(["memory", "Lore 1"]);
  expect(story.authorsNote).toBe("Use short sentences.");
});

test("import accepts a NovelAI Scenario with an empty prompt", async () => {
  const root = await project(true);
  const file = path.join(root, "primed.scenario");
  await writeFile(file, novelAiScenario({
    title: "Primed Scenario",
    prompt: "",
    context: { memory: "A story seed without prose." },
    lorebook: novelAiLorebook(1)
  }), "utf8");
  const out = collector();
  const errors = collector();

  await withExitCode(() => runStoryImport(
    [file, "--data", root],
    out.stream,
    errors.stream
  ));

  expect(out.text()).toContain('imported "Primed Scenario" (0 parts, 2 facts) as ');
  expect(errors.text()).toContain("0 prose parts");
  const story = await loadImportedStory(root, "Primed Scenario");
  expect(story.path).toHaveLength(0);
  expect(story.facts.map(({ tag }) => tag)).toEqual(["memory", "Lore 1"]);
});

async function project(initialize: boolean): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "1667-import-cli-"));
  created.push(root);
  if (initialize) await initializeProject(root);
  return root;
}

async function loadImportedStory(root: string, title: string) {
  const service = StoryService.withoutDiagnostics({ dataDir: path.join(root, ".1667") });
  await service.init();
  try {
    const summary = (await service.listStories()).find((story) => story.title === title);
    if (summary === undefined) throw new Error(`Imported story not found: ${title}`);
    return await service.loadStory(summary.id);
  } finally {
    await service.dispose();
  }
}

/** Import reports a partial batch through the exit status. Read that status,
 * then put back the status this test run started with, so a failure reported
 * here cannot fail the whole test process.
 *
 * Put back 0, not `undefined`: an assignment of `undefined` keeps the value
 * that is already there, which would leak this failure to the test run. */
async function withExitCode(
  run: () => Promise<unknown>
): Promise<number | string | undefined> {
  const before = process.exitCode ?? 0;
  process.exitCode = 0;
  try {
    await run();
    return process.exitCode;
  } finally {
    process.exitCode = before;
  }
}

function collector(): {
  readonly stream: { write: (text: string) => boolean };
  readonly text: () => string;
} {
  const parts: string[] = [];
  return {
    stream: { write: (text: string) => { parts.push(String(text)); return true; } },
    text: () => parts.join("")
  };
}

function sink(): { write: (text: string) => boolean } {
  return { write: () => true };
}

/** The message of the rejection, or a sentinel that fails the match. */
async function failure(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "the call resolved instead of failing";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
