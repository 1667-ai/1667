import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { KeyEvent } from "@opentui/core";
import { handleKey, initialState } from "../src/app.js";
import { demoAppSource } from "../src/demo.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText } from "../src/screens/story/frame.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";

const created: string[] = [];
const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

afterEach(async () => {
  for (const directory of created.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the command palette imports JSON card Facts and reports the character", async () => {
  const root = await temporaryDirectory();
  const file = path.join(root, "mira.json");
  await writeFile(file, JSON.stringify(card()), "utf8");

  const source = demoAppSource();
  const before = source.payload.facts.length;
  const state = await runImport(source, file);

  expect(state.payload.facts).toHaveLength(before + 1);
  expect(state.payload.facts.at(-1)).toMatchObject({ tag: "Character" });
  expect(state.toast).toBe(
    'imported 1 fact for "Mira" · description and personality · scenario was empty'
  );
  expect(state.card).toBe(null);
  expect(state.mode).toBe("NAV");
});

test("the command palette imports a PNG card through the same route", async () => {
  const root = await temporaryDirectory();
  const file = path.join(root, "mira.png");
  const payload = Buffer.from(JSON.stringify(card()), "utf8").toString("base64");
  await writeFile(file, png(textChunk("chara", payload)));

  const source = demoAppSource();
  const before = source.payload.facts.length;
  const state = await runImport(source, file);

  expect(state.payload.facts).toHaveLength(before + 1);
  expect(state.payload.facts.at(-1)).toMatchObject({ tag: "Character" });
  expect(state.toast).toContain('imported 1 fact for "Mira"');
});

test("tab extends the path to a common prefix and lists several candidates", async () => {
  const root = await temporaryDirectory();
  const directory = path.join(root, "cards");
  await mkdir(directory);
  await writeFile(path.join(directory, "mira-one.json"), "one");
  await writeFile(path.join(directory, "mira-two.json"), "two");
  await mkdir(path.join(directory, "mira-notes"));

  const source = demoAppSource();
  const state = initialState(source, false);
  await pressSequence(state, source, [
    key(":"),
    ..."import character card".split("").map((value) => key(value)),
    key("return", "\r"),
    ...`${directory}/mira`.split("").map((value) => key(value)),
    key("tab", "\t")
  ]);

  expect(state.mode).toBe("CARD");
  expect(state.card?.path).toBe(`${directory}/mira-`);
  expect(state.card?.candidates).toEqual(["mira-notes/", "mira-one.json", "mira-two.json"]);
  expect(state.card?.error).toBe(null);
});

test("more candidates than the panel shows are named, not dropped", async () => {
  const root = await temporaryDirectory();
  const directory = path.join(root, "cards");
  await mkdir(directory);
  for (let index = 0; index < 9; index += 1) {
    await writeFile(path.join(directory, `card-${index}.json`), "x");
  }

  const source = demoAppSource();
  const state = initialState(source, false);
  await pressSequence(state, source, [
    key(":"),
    ..."import character card".split("").map((value) => key(value)),
    key("return", "\r"),
    ...`${directory}/card-`.split("").map((value) => key(value)),
    key("tab", "\t")
  ]);

  expect(state.card?.candidates).toHaveLength(9);
  const frame = frameText(renderStoryScreen(state, {
    width: 120,
    height: 36,
    wrapCache: createWrapCache()
  }).lines);
  expect(frame).toContain("card-5.json");
  expect(frame).not.toContain("card-6.json");
  expect(frame).toContain("… 3 more");
});

test("a home-relative path is expanded before the card is read", async () => {
  const source = demoAppSource();
  const state = await runImport(source, "~/1667-no-such-card.json");

  // The field keeps the `~` the writer typed. Before it was expanded, the
  // literal `~` reached open() and every home-relative card failed to import.
  expect(state.mode).toBe("CARD");
  expect(state.card?.error).toContain(path.join(homedir(), "1667-no-such-card.json"));
  expect(state.card?.error).not.toContain("~");
});

test("an empty path names what the field wants instead of a system error", async () => {
  const source = demoAppSource();
  const state = await runImport(source, "");

  expect(state.mode).toBe("CARD");
  expect(state.card?.error).toBe("type the path to a character card file");
});

test("a crafted card name cannot put escape sequences on the screen", async () => {
  const root = await temporaryDirectory();
  const file = path.join(root, "crafted.json");
  const escape = String.fromCharCode(27);
  await writeFile(file, JSON.stringify({
    name: `Mira${escape}[31m`,
    description: "A cartographer."
  }), "utf8");

  const source = demoAppSource();
  const state = await runImport(source, file);

  expect(state.toast).toContain("imported 1 fact for");
  expect(state.toast).not.toContain(escape);
});

test("a crafted file name cannot put escape sequences on the screen", async () => {
  const root = await temporaryDirectory();
  const directory = path.join(root, "cards");
  await mkdir(directory);
  const escape = String.fromCharCode(27);
  await writeFile(path.join(directory, `mira${escape}[31m-one.json`), "one");
  await writeFile(path.join(directory, `mira${escape}[31m-two.json`), "two");

  const source = demoAppSource();
  const state = initialState(source, false);
  await pressSequence(state, source, [
    key(":"),
    ..."import character card".split("").map((value) => key(value)),
    key("return", "\r"),
    ...`${directory}/mira`.split("").map((value) => key(value)),
    key("tab", "\t")
  ]);

  // The state keeps the exact name the filesystem needs; the frame must not.
  expect(state.card?.path).toContain(escape);
  const frame = frameText(renderStoryScreen(state, {
    width: 120,
    height: 36,
    wrapCache: createWrapCache()
  }).lines);
  expect(frame).not.toContain(escape);
});

test("an offline import explains itself in the panel, not in a toast", async () => {
  const root = await temporaryDirectory();
  const file = path.join(root, "mira.json");
  await writeFile(file, JSON.stringify(card()), "utf8");

  const source = demoAppSource();
  const state = initialState(source, false);
  state.connection = { ...state.connection, down: true };
  await pressSequence(state, source, [
    key(":"),
    ..."import character card".split("").map((value) => key(value)),
    key("return", "\r"),
    ...file.split("").map((value) => key(value)),
    key("return", "\r")
  ]);

  expect(state.mode).toBe("CARD");
  expect(state.card?.error).toBe("offline · cannot import a card now");
});

test("a story swap during the file read cannot retarget the import", async () => {
  const root = await temporaryDirectory();
  const file = path.join(root, "mira.json");
  await writeFile(file, JSON.stringify(card()), "utf8");

  const source = demoAppSource();
  const targets: string[] = [];
  const createFact = source.api.createFact.bind(source.api);
  source.api.createFact = async (storyId, body) => {
    targets.push(storyId);
    return await createFact(storyId, body);
  };

  const state = initialState(source, false);
  await pressSequence(state, source, [
    key(":"),
    ..."import character card".split("").map((value) => key(value)),
    key("return", "\r"),
    ...file.split("").map((value) => key(value))
  ]);

  // Stand in for a story swap landing while the card file was being read: the
  // prompt was opened against a story that is no longer the current one.
  state.card!.storyId = "a-story-that-is-no-longer-open";
  const before = state.payload.facts.length;
  await pressSequence(state, source, [key("return", "\r")]);

  expect(targets).toHaveLength(0);
  expect(state.payload.facts).toHaveLength(before);
  expect(state.card?.error).toBe("the open story changed · start the import again");
});

test("completion matches the way the filesystem opens the file", async () => {
  const root = await temporaryDirectory();
  const directory = path.join(root, "cards");
  await mkdir(directory);
  await writeFile(path.join(directory, "mira.json"), "one");

  const source = demoAppSource();
  const state = initialState(source, false);
  await pressSequence(state, source, [
    key(":"),
    ..."import character card".split("").map((value) => key(value)),
    key("return", "\r"),
    ...`${directory}/MIra`.split("").map((value) => key(value)),
    key("tab", "\t")
  ]);

  expect(state.card?.error).toBe(null);
  expect(state.card?.path).toBe(`${directory}/mira.json`);
});

test("completion never takes back what the writer typed", async () => {
  const root = await temporaryDirectory();
  const directory = path.join(root, "cards");
  await mkdir(directory);
  await writeFile(path.join(directory, "Mira-one.json"), "one");
  await writeFile(path.join(directory, "mira-two.json"), "two");

  const source = demoAppSource();
  const state = initialState(source, false);
  await pressSequence(state, source, [
    key(":"),
    ..."import character card".split("").map((value) => key(value)),
    key("return", "\r"),
    ...`${directory}/mira`.split("").map((value) => key(value)),
    key("tab", "\t")
  ]);

  // The two names share no prefix, because their case differs at the first
  // character. The field must keep `mira` rather than lose it.
  expect(state.card?.path).toBe(`${directory}/mira`);
  expect(state.card?.candidates).toEqual(["Mira-one.json", "mira-two.json"]);
});

test("a busy backend explains itself in the panel", async () => {
  const root = await temporaryDirectory();
  const file = path.join(root, "mira.json");
  await writeFile(file, JSON.stringify(card()), "utf8");

  const source = demoAppSource();
  const state = initialState(source, false);
  await pressSequence(state, source, [
    key(":"),
    ..."import character card".split("").map((value) => key(value)),
    key("return", "\r"),
    ...file.split("").map((value) => key(value))
  ]);

  // Another backend task already owns the runtime, so the import is refused.
  state.backendTask = { id: 999, kind: "action", label: "autonaming", storyId: state.payload.id };
  const before = state.payload.facts.length;
  await pressSequence(state, source, [key("return", "\r")]);

  expect(state.mode).toBe("CARD");
  expect(state.payload.facts).toHaveLength(before);
  expect(state.card?.error).toBe("another task is running · start the import again");
});

test("a V3 card keeps the panel open with the module error", async () => {
  const root = await temporaryDirectory();
  const file = path.join(root, "v3.json");
  await writeFile(file, JSON.stringify({ spec: "chara_card_v3", data: {} }), "utf8");

  const source = demoAppSource();
  const state = await runImport(source, file);
  const error = "Character Card V3 is not supported yet; export a V2 PNG or JSON card.";

  expect(state.mode).toBe("CARD");
  expect(state.card?.error).toBe(error);
  const frame = frameText(renderStoryScreen(state, {
    width: 120,
    height: 36,
    wrapCache: createWrapCache()
  }).lines);
  expect(frame).toContain("· Character Card V3 is not supported yet; export a V2 PNG");
  expect(frame).toContain("or JSON card.");
});

async function runImport(
  source: ReturnType<typeof demoAppSource>,
  file: string
): Promise<ReturnType<typeof initialState>> {
  const state = initialState(source, false);
  await pressSequence(state, source, [
    key(":"),
    ..."import character card".split("").map((value) => key(value)),
    key("return", "\r"),
    ...file.split("").map((value) => key(value)),
    key("return", "\r")
  ]);
  return state;
}

async function pressSequence(
  state: ReturnType<typeof initialState>,
  source: ReturnType<typeof demoAppSource>,
  events: readonly KeyEvent[]
): Promise<void> {
  const cache = createWrapCache<ProseStyle>();
  for (const event of events) {
    await handleKey(event, state, source, cache, () => {}, async () => {}, () => {});
  }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "1667-card-import-tui-"));
  created.push(directory);
  return directory;
}

function key(name: string, sequence = name): KeyEvent {
  return { name, sequence, shift: false, ctrl: false, meta: false } as KeyEvent;
}

function card(): Record<string, unknown> {
  return {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: {
      name: "Mira",
      description: "A cartographer.",
      personality: "Exacting but kind.",
      scenario: ""
    }
  };
}

function textChunk(keyword: string, value: string): Uint8Array {
  return chunk("tEXt", asciiBytes(`${keyword}\0${value}`));
}

function png(...chunks: Uint8Array[]): Uint8Array {
  return concat(PNG_SIGNATURE, ...chunks, chunk("IEND", new Uint8Array()));
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const output = new Uint8Array(12 + data.length);
  new DataView(output.buffer).setUint32(0, data.length, false);
  output.set(asciiBytes(type), 4);
  output.set(data, 8);
  return output;
}

function asciiBytes(value: string): Uint8Array {
  return Uint8Array.from(value, (character) => character.charCodeAt(0));
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(arrays.reduce((sum, value) => sum + value.length, 0));
  let offset = 0;
  for (const value of arrays) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}
