import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { KeyEvent } from "@opentui/core";
import { ActionRuntime } from "../src/action-runtime.js";
import { openArchiveImport } from "../src/archive-import-actions.js";
import { openCardImport } from "../src/card-import-actions.js";
import { dispatch, handleKey, initialState } from "../src/app.js";
import type { ActionContext } from "../src/action-context.js";
import { createAsideSurface } from "../src/aside-surface.js";
import { demoAppSource } from "../src/demo.js";
import {
  FROM_ASIDE_INSTRUCTION,
  openPlacementFromAside
} from "../src/aside-placement.js";
import { openAsideUseMenu } from "../src/aside-use.js";
import { createStoryViewModel, rowIndexForNode } from "../src/model.js";
import { setComposerText } from "../src/composer-model.js";
import { draftImagesFor } from "../src/draft-image.js";
import { searchRows } from "../src/search-model.js";
import { openTag } from "../src/story-actions.js";
import { PNG_SIGNATURE } from "../../shared/png-text-chunk.js";
import type { ProseStyle } from "../src/wrap.js";
import { createWrapCache } from "../src/wrap.js";
import { openLibrary } from "../src/library-actions.js";
import { renderStoryScreen } from "../src/screens/story.js";

const created: string[] = [];

afterEach(async () => {
  for (const directory of created.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

function ctrlP(): KeyEvent {
  return key("p", { sequence: "\u0010", ctrl: true });
}

function key(
  name: string,
  options: { sequence?: string; ctrl?: boolean; shift?: boolean } = {}
): KeyEvent {
  return {
    name,
    sequence: options.sequence ?? name,
    shift: options.shift ?? false,
    ctrl: options.ctrl ?? false,
    meta: false,
    option: false,
    super: false
  } as KeyEvent;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

async function typeQuery(
  press: (event: KeyEvent) => Promise<void>,
  query: string
): Promise<void> {
  for (const character of query) await press(key(character));
}

function minimalPng(width = 64, height = 48): Uint8Array {
  const bytes = new Uint8Array(29);
  bytes.set(PNG_SIGNATURE, 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13, false);
  bytes.set(new TextEncoder().encode("IHDR"), 12);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  bytes[24] = 8;
  bytes[25] = 6;
  return bytes;
}

function testHarness(renderer: ActionContext["renderer"] = null) {
  const source = demoAppSource();
  const state = initialState(source, false);
  const cache = createWrapCache<ProseStyle>();
  const backend = new ActionRuntime(state, () => undefined);
  const press = (event: KeyEvent) => handleKey(
    event,
    state,
    source,
    cache,
    () => undefined,
    async () => undefined,
    () => undefined,
    renderer,
    () => undefined,
    () => undefined,
    backend
  );
  const context = {
    backend,
    cache,
    repaint: () => undefined,
    renderer,
    applyTheme: () => undefined,
    previewTheme: () => undefined
  };
  return { source, state, press, context };
}

/** A NativeSelectionSnapshot in CliRenderer's clothing. The selection reader
 * treats this plain object as the captured renderer state. */
function stubSelectionRenderer(text: string): ActionContext["renderer"] {
  return { identity: {}, text, range: { start: 0, end: text.length }, backward: false } as never;
}

describe("palette async settlement", () => {
  test("keeps a newer palette visible when deferred Aside opens", async () => {
    const { source, state, press } = testHarness();
    const entered = deferred<void>();
    const release = deferred<{ notes: readonly { question: string; answer: string }[] }>();
    source.api.getAside = async () => {
      entered.resolve();
      return await release.promise;
    };

    await press(ctrlP());
    await typeQuery(press, "aside");
    const opening = press(key("return", { sequence: "\r" }));
    await entered.promise;

    await press(ctrlP());
    const newerPalette = state.commands;
    expect(state.mode).toBe("COMMANDS");
    expect(newerPalette?.returnMode).toBe("NAV");

    release.resolve({ notes: [] });
    await opening;

    expect(state.aside).not.toBeNull();
    expect(state.mode).toBe("COMMANDS");
    expect(state.commands).toBe(newerPalette);
    expect(state.commands?.returnMode).toBe("ASIDE");

    await press(key("escape", { sequence: "\u001b" }));
    expect(state.mode).toBe("ASIDE");
    expect(state.commands).toBeNull();
  });

  test("keeps a newer palette visible when direct Aside opens slowly", async () => {
    const { source, state, press } = testHarness();
    const entered = deferred<void>();
    const release = deferred<{ notes: readonly { question: string; answer: string }[] }>();
    source.api.getAside = async () => {
      entered.resolve();
      return await release.promise;
    };

    const opening = press(key("a"));
    await entered.promise;

    await press(ctrlP());
    const newerPalette = state.commands;
    expect(state.mode).toBe("COMMANDS");
    expect(newerPalette?.returnMode).toBe("NAV");

    release.resolve({ notes: [] });
    await opening;

    expect(state.aside).not.toBeNull();
    expect(state.mode).toBe("COMMANDS");
    expect(state.commands).toBe(newerPalette);
    expect(state.commands?.returnMode).toBe("ASIDE");

    await press(key("escape", { sequence: "\u001b" }));
    expect(state.mode).toBe("ASIDE");
    expect(state.commands).toBeNull();
  });

  test("keeps the palette visible after a Card import settles", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "1667-card-palette-"));
    created.push(directory);
    const file = path.join(directory, "mira.json");
    await writeFile(file, JSON.stringify({
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: { name: "Mira", description: "A cartographer." }
    }));

    const { source, state, press } = testHarness();
    const entered = deferred<void>();
    const release = deferred<void>();
    const importCard = source.api.importCard;
    source.api.importCard = async (...args) => {
      entered.resolve();
      await release.promise;
      return importCard(...args);
    };
    openCardImport(state);
    state.card!.path = file;

    const importing = press(key("return", { sequence: "\r" }));
    await entered.promise;
    await press(ctrlP());
    expect(state.mode).toBe("COMMANDS");
    expect(state.commands?.returnMode).toBe("CARD");

    release.resolve();
    await importing;
    expect(state.mode).toBe("COMMANDS");
    expect(state.commands).not.toBeNull();
    expect(state.commands?.returnMode).toBe("NAV");
    expect(state.card).toBeNull();

    await press(key("escape", { sequence: "\u001b" }));
    expect(state.mode).toBe("NAV");
    expect(state.commands).toBeNull();
  });

  test("keeps the palette visible after a same-story archive import settles", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "1667-archive-palette-"));
    created.push(directory);
    const file = path.join(directory, "world.lorebook");
    await writeFile(file, JSON.stringify({ lorebookVersion: 6, entries: [] }));

    const { source, state, press } = testHarness();
    const entered = deferred<void>();
    const release = deferred<void>();
    source.api.importLorebook = async () => {
      entered.resolve();
      await release.promise;
      return {
        payload: source.payload,
        importResult: { facts: [], fidelity: [] }
      };
    };
    openArchiveImport(state);
    state.archive!.path = file;

    const importing = press(key("return", { sequence: "\r" }));
    await entered.promise;
    await press(ctrlP());
    expect(state.mode).toBe("COMMANDS");
    expect(state.commands?.returnMode).toBe("ARCHIVE");

    release.resolve();
    await importing;
    expect(state.mode).toBe("COMMANDS");
    expect(state.commands).not.toBeNull();
    expect(state.commands?.returnMode).toBe("NAV");
    expect(state.archive).toBeNull();

    await press(key("escape", { sequence: "\u001b" }));
    expect(state.mode).toBe("NAV");
    expect(state.commands).toBeNull();
  });

  test("keeps the palette visible after a cross-story archive import and clears its selection", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "1667-cross-story-palette-"));
    created.push(directory);
    const file = path.join(directory, "new.story");
    await writeFile(file, "{}");

    const { source, state, press } = testHarness(stubSelectionRenderer("old"));
    const imported = structuredClone(source.payload);
    imported.id = "imported-story";
    imported.title = "Imported story";

    const entered = deferred<void>();
    const release = deferred<void>();
    source.api.importNovelAI = async () => {
      entered.resolve();
      await release.promise;
      return { payload: imported, fidelity: [] };
    };
    state.storySelectionProjection = [
      { key: "old:text", text: "old", start: 0, end: 1 },
      { key: "old:text", text: "old", start: 1, end: 2 },
      { key: "old:text", text: "old", start: 2, end: 3 }
    ];
    openArchiveImport(state);
    state.archive!.path = file;

    const importing = press(key("return", { sequence: "\r" }));
    await entered.promise;
    await press(ctrlP());
    expect(state.mode).toBe("COMMANDS");
    expect(state.commands?.returnMode).toBe("ARCHIVE");
    expect(state.commands?.selection?.text).toBe("old");

    release.resolve();
    await importing;
    expect(state.payload.id).toBe(imported.id);
    expect(state.mode).toBe("COMMANDS");
    expect(state.commands).not.toBeNull();
    expect(state.commands?.returnMode).toBe("NAV");
    expect(state.commands?.selection ?? null).toBeNull();
    expect(state.archive).toBeNull();

    await press(key("escape", { sequence: "\u001b" }));
    expect(state.mode).toBe("NAV");
    expect(state.commands).toBeNull();
    expect(state.payload.id).toBe(imported.id);
  });

  test("keeps the palette visible after image staging settles", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "1667-image-palette-"));
    created.push(directory);
    const file = path.join(directory, "art.png");
    await writeFile(file, minimalPng());

    const { source, state, press } = testHarness();
    const entered = deferred<void>();
    const release = deferred<void>();
    source.api.stageStoryImage = async () => {
      entered.resolve();
      await release.promise;
      return {
        leaseId: "a".repeat(64),
        attachment: {
          objectId: "b".repeat(64),
          mediaType: "image/png",
          width: 64,
          height: 48,
          byteLength: 4_096
        }
      };
    };
    state.mode = "IMAGE";
    state.image = {
      path: file,
      storyId: state.payload.id,
      candidates: [],
      error: null,
      returnMode: "COMPOSE"
    };

    const staging = press(key("return", { sequence: "\r" }));
    await entered.promise;
    await press(ctrlP());
    expect(state.mode).toBe("COMMANDS");
    expect(state.commands?.returnMode).toBe("IMAGE");

    release.resolve();
    await staging;
    expect(state.mode).toBe("COMMANDS");
    expect(state.commands).not.toBeNull();
    expect(state.commands?.returnMode).toBe("COMPOSE");
    expect(state.image).toBeNull();
    expect(draftImagesFor(state.composer)).toHaveLength(1);

    await press(key("escape", { sequence: "\u001b" }));
    expect(state.mode).toBe("COMPOSE");
    expect(state.commands).toBeNull();
  });

  test("keeps the palette visible after a Library story load settles", async () => {
    const { source, state, press, context } = testHarness();
    await openLibrary(state, source, context);
    const target = source.stories.find(({ id }) => id !== source.payload.id)!;
    state.library!.cursor = state.library!.stories.findIndex(({ id }) => id === target.id);

    const entered = deferred<void>();
    const release = deferred<typeof state.payload>();
    source.api.loadStory = async (storyId) => {
      expect(storyId).toBe(target.id);
      entered.resolve();
      return await release.promise;
    };

    const loading = press(key("return", { sequence: "\r" }));
    await entered.promise;
    await press(ctrlP());
    expect(state.mode).toBe("COMMANDS");
    expect(state.commands?.returnMode).toBe("LIBRARY");

    release.resolve({
      ...source.payload,
      id: target.id,
      title: target.title
    });
    await loading;
    expect(state.payload.id).toBe(target.id);
    expect(state.mode).toBe("COMMANDS");
    expect(state.commands).not.toBeNull();
    expect(state.commands?.returnMode).toBe("NAV");
    expect(state.library).toBeNull();

    await press(key("escape", { sequence: "\u001b" }));
    expect(state.mode).toBe("NAV");
    expect(state.commands).toBeNull();
    expect(state.payload.id).toBe(target.id);
  });

  test("cross-story Library load clears the palette selection before Fact creation", async () => {
    const { source, state, press, context } = testHarness();
    await openLibrary(state, source, context);
    const target = source.stories.find(({ id }) => id !== source.payload.id)!;
    state.library!.cursor = state.library!.stories.findIndex(({ id }) => id === target.id);

    const entered = deferred<void>();
    const release = deferred<typeof state.payload>();
    source.api.loadStory = async (storyId) => {
      expect(storyId).toBe(target.id);
      entered.resolve();
      return await release.promise;
    };

    const loading = press(key("return", { sequence: "\r" }));
    await entered.promise;
    await press(ctrlP());
    state.commands!.selection = {
      text: "old story text",
      spans: [{ key: "p12:text", text: "old story text", start: 0, end: 15 }]
    };

    release.resolve({
      ...source.payload,
      id: target.id,
      title: target.title
    });
    await loading;

    expect(state.payload.id).toBe(target.id);
    expect(state.mode).toBe("COMMANDS");
    expect(state.commands?.selection ?? null).toBeNull();

    await typeQuery(press, "new fact from selection");
    await press(key("return", { sequence: "\r" }));
    expect(state.editor).toBeNull();
    expect(state.mode).toBe("COMMANDS");
  });

  test("keeps the palette visible after an inline editor save settles", async () => {
    const { source, state, press } = testHarness();
    state.focusIndex = rowIndexForNode(createStoryViewModel(state.payload), "p12");
    await press(key("e"));
    if (state.editor?.kind !== "document" || state.editor.target.kind !== "part") {
      throw new Error("part editor did not open");
    }
    const editor = state.editor;
    setComposerText(editor.composer, "saved direction\n---\nsaved prose");

    const entered = deferred<void>();
    const release = deferred<void>();
    const editNode = source.api.editNode;
    source.api.editNode = async (...args) => {
      entered.resolve();
      await release.promise;
      return editNode(...args);
    };

    const saving = press(key("o", { sequence: "\u000f", ctrl: true }));
    await entered.promise;
    await press(ctrlP());
    expect(state.mode).toBe("COMMANDS");
    expect(state.commands?.returnMode).toBe("EDITOR");

    release.resolve();
    await saving;
    expect(state.mode).toBe("COMMANDS");
    expect(state.commands).not.toBeNull();
    expect(state.commands?.returnMode).toBe("NAV");
    expect(state.editor).toBeNull();

    await press(key("escape", { sequence: "\u001b" }));
    expect(state.mode).toBe("NAV");
    expect(state.commands).toBeNull();
  });

  test("keeps Next Request visible while an editor save settles", async () => {
    const { source, state, press } = testHarness();
    state.focusIndex = rowIndexForNode(createStoryViewModel(state.payload), "p12");
    await press(key("e"));
    if (state.editor?.kind !== "document" || state.editor.target.kind !== "part") {
      throw new Error("part editor did not open");
    }
    const editor = state.editor;
    setComposerText(editor.composer, "saved direction\n---\nsaved prose");

    const entered = deferred<void>();
    const release = deferred<void>();
    const editNode = source.api.editNode;
    source.api.editNode = async (...args) => {
      entered.resolve();
      await release.promise;
      return editNode(...args);
    };

    const saving = press(key("o", { sequence: "\u000f", ctrl: true }));
    await entered.promise;
    await press(ctrlP());
    await typeQuery(press, "next request");
    await press(key("return", { sequence: "\r" }));

    expect(state.mode).toBe("REQUEST");
    expect(state.request?.returnMode).toBe("EDITOR");
    expect(state.editor).toBe(editor);

    release.resolve();
    await saving;

    expect(state.mode).toBe("REQUEST");
    expect(state.request?.returnMode).toBe("NAV");
    expect(state.editor).toBeNull();

    await press(key("escape", { sequence: "\u001b" }));
    expect(state.mode).toBe("NAV");
    expect(state.request).toBeNull();
  });

  test("keeps the palette visible after Placement settles", async () => {
    const { source, state, press, context } = testHarness();
    const answer = "placed below the palette";
    const surface = createAsideSurface(
      state.payload.id,
      state.payload.title,
      [{ question: "Where?", answer }],
      null,
      state.payload.path.at(-1)!.id
    );
    state.aside = surface;
    state.mode = "ASIDE";
    expect(openAsideUseMenu(surface, 0, 0)).toBeTrue();
    expect(openPlacementFromAside(state)).toBeTrue();
    expect(state.mode).toBe("PLACE");

    const entered = deferred<void>();
    const release = deferred<void>();
    const createNode = source.api.createNode;
    source.api.createNode = async (...args) => {
      entered.resolve();
      await release.promise;
      return createNode(...args);
    };

    const placing = dispatch(
      { action: "apply" },
      state,
      source,
      context.cache,
      () => undefined,
      async () => undefined,
      () => undefined,
      null,
      () => undefined,
      () => undefined,
      context.backend
    );
    await entered.promise;
    await press(ctrlP());
    expect(state.mode).toBe("COMMANDS");
    expect(state.commands?.returnMode).toBe("PLACE");

    release.resolve();
    await placing;
    expect(state.mode).toBe("COMMANDS");
    expect(state.commands).not.toBeNull();
    expect(state.commands?.returnMode).toBe("NAV");
    expect(state.placement).toBeNull();
    expect(state.payload.path.at(-1)?.instruction).toBe(FROM_ASIDE_INSTRUCTION);

    await press(key("escape", { sequence: "\u001b" }));
    expect(state.mode).toBe("NAV");
    expect(state.commands).toBeNull();
  });

  test("keeps the palette visible after a tag save settles", async () => {
    const { source, state, press } = testHarness();
    openTag(state, "p13");
    if (state.tag === null) throw new Error("tag prompt did not open");
    state.tag.name = "saved tag";
    await press(key("return", { sequence: "\r" }));

    const entered = deferred<void>();
    const release = deferred<void>();
    const putBookmark = source.api.putBookmark;
    source.api.putBookmark = async (...args) => {
      entered.resolve();
      await release.promise;
      return putBookmark(...args);
    };

    const saving = press(key("return", { sequence: "\r" }));
    await entered.promise;
    await press(ctrlP());
    expect(state.mode).toBe("COMMANDS");
    expect(state.commands?.returnMode).toBe("TAG");

    release.resolve();
    await saving;
    expect(state.mode).toBe("COMMANDS");
    expect(state.commands?.returnMode).toBe("NAV");
    expect(state.tag).toBeNull();

    await press(key("escape", { sequence: "\u001b" }));
    expect(state.mode).toBe("NAV");
    expect(state.commands).toBeNull();
  });

  test("keeps the palette visible after a tag delete settles", async () => {
    const { source, state, press } = testHarness();
    openTag(state, "p13");
    if (state.tag === null) throw new Error("tag prompt did not open");
    state.tag.choosingStatus = true;

    const entered = deferred<void>();
    const release = deferred<void>();
    const deleteBookmark = source.api.deleteBookmark;
    source.api.deleteBookmark = async (...args) => {
      entered.resolve();
      await release.promise;
      return deleteBookmark(...args);
    };

    await press(key("d", { sequence: "D", shift: true }));
    const deleting = press(key("d", { sequence: "D", shift: true }));
    await entered.promise;
    await press(ctrlP());
    expect(state.mode).toBe("COMMANDS");
    expect(state.commands?.returnMode).toBe("TAG");

    release.resolve();
    await deleting;
    expect(state.mode).toBe("COMMANDS");
    expect(state.commands?.returnMode).toBe("NAV");
    expect(state.tag).toBeNull();
    expect(state.payload.tags.some(({ nodeId }) => nodeId === "p13")).toBeFalse();

    await press(key("escape", { sequence: "\u001b" }));
    expect(state.mode).toBe("NAV");
    expect(state.commands).toBeNull();
  });

  test("keeps the palette visible after a cross-story Search hit settles", async () => {
    const { source, state, press } = testHarness();
    source.searchDebounceMs = 0;
    await press(key("/"));
    await typeQuery(press, "road");
    await press(key("tab", { sequence: "\t" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const search = state.search;
    if (search === null || search.response === null) throw new Error("search did not settle");
    const foreign = search.response.hits.find((hit) => hit.storyId !== state.payload.id);
    if (foreign === undefined) throw new Error("foreign Search hit did not appear");
    const hitRow = searchRows(search, state.payload).rows.find(
      (row): row is Extract<typeof row, { kind: "hit" }> => row.kind === "hit" && row.hit === foreign
    );
    if (hitRow === undefined) throw new Error("foreign Search hit row did not appear");
    search.cursor = hitRow.select;

    const entered = deferred<void>();
    const release = deferred<void>();
    const loadStory = source.api.loadStory;
    source.api.loadStory = async (...args) => {
      entered.resolve();
      await release.promise;
      return loadStory(...args);
    };
    const opening = press(key("return", { sequence: "\r" }));
    await entered.promise;
    await press(ctrlP());
    expect(state.mode).toBe("COMMANDS");
    expect(state.commands?.returnMode).toBe("SEARCH");
    state.commands!.selection = {
      text: "old story text",
      spans: [{ key: "p12:text", text: "old story text", start: 0, end: 15 }]
    };

    release.resolve();
    await opening;
    expect(state.payload.id).toBe(foreign.storyId);
    expect(state.mode).toBe("COMMANDS");
    expect(state.commands?.returnMode).toBe("NAV");
    expect(state.commands?.selection ?? null).toBeNull();
    expect(state.search).toBeNull();

    await press(key("escape", { sequence: "\u001b" }));
    expect(state.mode).toBe("NAV");
    expect(state.commands).toBeNull();
    expect(state.payload.id).toBe(foreign.storyId);
  });

  test("opens a cross-story Fact Search hit beneath the palette", async () => {
    const { source, state, press } = testHarness();
    source.searchDebounceMs = 0;
    await press(key("/"));
    await typeQuery(press, "lantern-house");
    await press(key("tab", { sequence: "\t" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const search = state.search;
    if (search === null || search.response === null) throw new Error("search did not settle");
    const foreign = search.response.hits.find(
      (hit) => hit.storyId !== state.payload.id && hit.kind === "fact"
    );
    if (foreign === undefined) throw new Error("foreign Fact Search hit did not appear");
    const hitRow = searchRows(search, state.payload).rows.find(
      (row): row is Extract<typeof row, { kind: "hit" }> => row.kind === "hit" && row.hit === foreign
    );
    if (hitRow === undefined) throw new Error("foreign Fact Search hit row did not appear");
    search.cursor = hitRow.select;

    const entered = deferred<void>();
    const release = deferred<void>();
    const loadStory = source.api.loadStory;
    source.api.loadStory = async (...args) => {
      entered.resolve();
      await release.promise;
      return loadStory(...args);
    };
    const opening = press(key("return", { sequence: "\r" }));
    await entered.promise;
    await press(ctrlP());
    expect(state.mode).toBe("COMMANDS");
    expect(state.commands?.returnMode).toBe("SEARCH");

    release.resolve();
    await opening;
    expect(state.payload.id).toBe(foreign.storyId);
    expect(state.search).toBeNull();
    expect(state.facts).not.toBeNull();
    expect(state.facts?.cursor).toBe(0);
    expect(state.payload.facts[state.facts?.cursor ?? -1]?.id).toBe(foreign.targetId);
    expect(state.mode).toBe("COMMANDS");
    expect(state.commands?.returnMode).toBe("FACTS");
    expect(state.commands?.selection ?? null).toBeNull();

    await press(key("escape", { sequence: "\u001b" }));
    expect(state.mode).toBe("FACTS");
    expect(state.commands).toBeNull();
  });

});
