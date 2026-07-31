import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initializeProject } from "../../server/project-discovery.js";
import { parseImportCommand, runStoryImport } from "../src/import-cli.js";

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

test("import parsing names its source and refuses to guess one", () => {
  expect(parseImportCommand(["sillytavern", "chat.jsonl"])).toEqual({
    source: "sillytavern",
    files: ["chat.jsonl"],
    data: null,
    global: false
  });
  expect(parseImportCommand([
    "sillytavern", "a.jsonl", "b.jsonl", "--data", "/tmp/p"
  ]).files).toEqual(["a.jsonl", "b.jsonl"]);

  // The source is named, never inferred from the file, so a file cannot be
  // read as a format it is not.
  expect(() => parseImportCommand([])).toThrow(/needs a source/u);
  expect(() => parseImportCommand(["chat.jsonl"])).toThrow(/unknown import source/u);
  expect(() => parseImportCommand(["sillytavern"])).toThrow(/needs a file/u);
  expect(() => parseImportCommand(["sillytavern", "a.jsonl", "--nope"]))
    .toThrow(/unknown import option/u);
  expect(() => parseImportCommand(["sillytavern", "a.jsonl", "--global", "--data=/tmp/p"]))
    .toThrow(/select different projects/u);
});

test("import refuses a directory that is not a project rather than making one", async () => {
  const root = await project(false);
  const file = path.join(root, "chat.jsonl");
  await writeFile(file, CHAT, "utf8");

  // Importing into a directory with no project would create one, import into
  // it, and leave the starter stories it had just invented beside the result.
  expect(await failure(() => runStoryImport(
    ["sillytavern", file, "--data", root],
    sink(),
    sink()
  ))).toMatch(/not a 1667 story project yet/u);
});

test("import reads a SillyTavern chat into one new story", async () => {
  const root = await project(true);
  const file = path.join(root, "chat.jsonl");
  await writeFile(file, CHAT, "utf8");
  const out = collector();

  await runStoryImport(["sillytavern", file, "--data", root], out.stream, sink());

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

  expect(await failure(() => runStoryImport(
    ["sillytavern", missing, good, "--data", root],
    out.stream,
    errors.stream
  ))).toMatch(/did not read every file/u);

  // The reachable file still became a story. A failure is reported, not fatal.
  expect(out.text()).toMatch(/imported "/u);
  expect(errors.text()).toMatch(/missing\.jsonl/u);
});

async function project(initialize: boolean): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "1667-import-cli-"));
  created.push(root);
  if (initialize) await initializeProject(root);
  return root;
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
