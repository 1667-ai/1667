import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { KeyEvent } from "@opentui/core";
import { INERT_UPDATE_CHECK_LIFECYCLE } from "../src/action-context.js";
import { factsFromLorebook, parseLorebookArchive } from "../../shared/novelai-lorebook.js";
import {
  novelAiScenario,
  novelAiStoryContainer
} from "../../test/novelai-container-fixture.js";
import { openArchiveImport } from "../src/archive-import-actions.js";
import { handleKey, initialState } from "../src/app.js";
import { demoAppSource } from "../src/demo.js";
import { recordSessionNotices } from "../src/notice-log.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText } from "../src/screens/story/frame.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";

const created: string[] = [];

afterEach(async () => {
  for (const directory of created.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the palette lists import archive and opens its panel", async () => {
  const source = demoAppSource();
  const state = initialState(source, false);

  await pressSequence(state, source, [
    key(":"),
    ..."import archive".split("").map((value) => key(value)),
    key("return", "\r")
  ]);

  expect(state.mode).toBe("ARCHIVE");
  expect(state.archive).toMatchObject({
    path: "",
    storyId: source.payload.id,
    candidates: [],
    error: null,
    returnMode: "NAV"
  });
  const frame = rendered(state);
  expect(frame).toContain("┏━ import archive ━");
  expect(frame).toContain(".lorebook .json → Facts · .scenario .story → new story");
});

test("tab completes an archive path and names candidates beyond the first six", async () => {
  const root = await temporaryDirectory();
  const directory = path.join(root, "archives");
  await mkdir(directory);
  for (let index = 0; index < 9; index += 1) {
    await writeFile(path.join(directory, `lantern-${index}.story`), "x");
  }

  const source = demoAppSource();
  const state = initialState(source, false);
  await pressSequence(state, source, [
    key(":"),
    ..."import archive".split("").map((value) => key(value)),
    key("return", "\r"),
    ...`${directory}/lant`.split("").map((value) => key(value)),
    key("tab", "\t")
  ]);

  expect(state.archive?.path).toBe(`${directory}/lantern-`);
  expect(state.archive?.candidates).toHaveLength(9);
  const frame = rendered(state);
  expect(frame).toContain("lantern-5.story");
  expect(frame).not.toContain("lantern-6.story");
  expect(frame).toContain("… 3 more");
});

test("enter on a Lorebook adds Facts to the open story and reports headline counts", async () => {
  const root = await temporaryDirectory();
  const file = path.join(root, "lantern.lorebook");
  await writeFile(file, JSON.stringify({
    lorebookVersion: 6,
    entries: [
      { enabled: true, text: "The lamp burns blue.", forceActivation: true },
      { enabled: true, text: "Maren keeps the key.", keys: ["Maren"] }
    ]
  }), "utf8");

  const source = demoAppSource();
  const target = source.payload.id;
  let calledStoryId: string | null = null;
  source.api.importLorebook = async (storyId, bytes) => {
    calledStoryId = storyId;
    const importResult = factsFromLorebook(
      parseLorebookArchive(bytes),
      128 - source.payload.facts.length
    );
    const payload = await source.api.createFact(storyId, { facts: [...importResult.facts] });
    return { payload, importResult };
  };

  const before = source.payload.facts.length;
  const state = await runImport(source, file);

  expect(calledStoryId).toBe(target);
  expect(state.payload.facts).toHaveLength(before + 2);
  expect(state.toast).toBe("2 Facts imported · 1 keyed · 1 always · ! full report");
  expect(state.archive).toBe(null);
  expect(state.mode).toBe("NAV");
});

test("enter on a Scenario creates and opens a new story", async () => {
  const root = await temporaryDirectory();
  const file = path.join(root, "lantern.scenario");
  const content = novelAiScenario({ title: "The New Lantern", prompt: "A new opening." });
  await writeFile(file, content, "utf8");

  const source = demoAppSource();
  const imported = structuredClone(source.payload);
  imported.id = "imported-scenario";
  imported.title = "The New Lantern";
  let received = "";
  source.api.importScenario = async (jsonText) => {
    received = jsonText;
    return { payload: imported, fidelity: [] };
  };

  const state = await runImport(source, file);

  expect(received).toBe(content);
  expect(state.payload.id).toBe("imported-scenario");
  expect(state.payload.title).toBe("The New Lantern");
  expect(state.toast).toContain(`new story · ${imported.nodes.length} parts`);
  expect(state.archive).toBe(null);
});

test("enter on a Story Container uses the full NovelAI import path", async () => {
  const root = await temporaryDirectory();
  const file = path.join(root, "lantern.story");
  const content = novelAiStoryContainer({ title: "The Story Container" });
  await writeFile(file, content, "utf8");

  const source = demoAppSource();
  const imported = structuredClone(source.payload);
  imported.id = "imported-container";
  imported.title = "The Story Container";
  let received = "";
  source.api.importNovelAI = async (storyContainerJson) => {
    received = storyContainerJson;
    return { payload: imported, fidelity: [] };
  };

  const state = await runImport(source, file);

  expect(received).toBe(content);
  expect(state.payload.id).toBe("imported-container");
  expect(state.toast).toContain("new story");
});

test("an unsupported extension explains itself in the open panel", async () => {
  const source = demoAppSource();
  const state = await runImport(source, "/tmp/lantern.txt");

  expect(state.mode).toBe("ARCHIVE");
  expect(state.archive?.error).toBe(
    "unsupported archive · use .lorebook, .json, .scenario, or .story"
  );
  const frame = rendered(state);
  // The reason is longer than the value column, so the panel wraps it rather
  // than cutting the list of what the command does accept.
  expect(frame).toContain("· unsupported archive · use .lorebook, .json, .scenario,");
  expect(frame).toContain("or .story");
});

test("a lossy World Info import writes its whole report to the log", async () => {
  // The toast holds four rows and the report does not, so a writer importing in
  // the app must still be able to reach what the archive lost.
  const root = await temporaryDirectory();
  const file = path.join(root, "world.json");
  await writeFile(file, JSON.stringify({
    entries: { "0": { uid: 0, comment: "Weather", content: "The pass closes.", key: ["storm"] } }
  }), "utf8");

  const source = demoAppSource();
  source.api.importLorebook = async () => ({
    payload: source.payload,
    importResult: {
      facts: [{ tag: "Weather", text: "The pass closes.", activation: "keyed" as const, keys: ["storm"] }],
      fidelity: ["1 entry read", "1 fact imported", "2 regular expression keys dropped; a fact key is literal"]
    }
  });

  const state = await runImport(source, file);

  expect(state.toast).toContain("! full report");

  // Run the recorder the app runs, so the toast lands in the log the same way
  // it does at runtime. The headline is newest and the log opens on the notice
  // the writer came from; the whole report must survive directly under it.
  recordSessionNotices(state);
  const texts = state.notices.entries.map((entry) => String(entry.text));
  expect(texts[0]).toContain("! full report");
  expect(texts[1]).toContain("2 regular expression keys dropped");
});

test("escape closes the archive panel and restores its previous mode", async () => {
  const source = demoAppSource();
  source.api.importLorebook = async () => ({
    payload: source.payload,
    importResult: { facts: [], fidelity: ["1 entry read", "0 facts imported"] }
  });
  const state = initialState(source, false);
  state.mode = "COMPOSE";
  openArchiveImport(state);

  await pressSequence(state, source, [key("escape", "\u001b")]);

  expect(state.archive).toBe(null);
  expect(state.mode).toBe("COMPOSE");
});

async function runImport(
  source: ReturnType<typeof demoAppSource>,
  file: string
): Promise<ReturnType<typeof initialState>> {
  const state = initialState(source, false);
  await pressSequence(state, source, [
    key(":"),
    ..."import archive".split("").map((value) => key(value)),
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
    await handleKey(
      event, state, source, cache, () => {}, async () => {}, () => {},
      { updateChecks: INERT_UPDATE_CHECK_LIFECYCLE }
    );
  }
}

function rendered(state: ReturnType<typeof initialState>): string {
  return frameText(renderStoryScreen(state, {
    width: 120,
    height: 36,
    wrapCache: createWrapCache()
  }).lines);
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "1667-archive-import-tui-"));
  created.push(directory);
  return directory;
}

function key(name: string, sequence = name): KeyEvent {
  return { name, sequence, shift: false, ctrl: false, meta: false } as KeyEvent;
}

test("an import started from the composer names a way to the report that works", async () => {
  // `!` opens the log in NAV and MAP only. Returning to COMPOSE it would type
  // into the draft, so the toast must not advertise it bare.
  const root = await temporaryDirectory();
  const file = path.join(root, "world.json");
  await writeFile(file, JSON.stringify({
    entries: { "0": { uid: 0, comment: "Weather", content: "The pass closes.", key: ["storm"] } }
  }), "utf8");

  const source = demoAppSource();
  source.api.importLorebook = async () => ({
    payload: source.payload,
    importResult: { facts: [], fidelity: ["1 entry read", "0 facts imported"] }
  });
  const state = initialState(source, false);
  state.mode = "COMPOSE";
  openArchiveImport(state);
  expect(state.archive?.returnMode).toBe("COMPOSE");

  await pressSequence(state, source, [
    ...file.split("").map((value) => key(value)),
    key("return", "\r")
  ]);

  expect(state.archive?.error ?? null).toBe(null);
  expect(state.mode).toBe("COMPOSE");
  expect(state.toast).toContain("full report in the log");
  // No keystroke is promised: from a fullscreen composer the first esc only
  // leaves fullscreen, so a count of presses would be wrong.
  expect(state.toast).not.toContain("esc then");
});
