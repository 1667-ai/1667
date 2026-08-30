import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { demoAppSource } from "../src/demo.js";
import { handleKey, initialState } from "../src/app.js";
import {
  asideCursor,
  asideNotes,
  createAsideSurface,
  currentAsideTurns,
  isAsideV2,
  type AsideSessionSurfaceState,
  type AsideSessionView
} from "../src/aside-surface.js";
import {
  asideFooterHint,
  asideHistoryWindow,
  openAside,
  sendAsideQuestion,
  stopAsideAsk
} from "../src/aside-actions.js";
import { asideChatLayout, asideSessionsFromResponse } from "../src/aside-v2-layout.js";
import { asideHopEntries, asideHopStripText } from "../src/aside-hop.js";
import { asideV2KeyAction, cycleAsideSession } from "../src/aside-v2-actions.js";
import { recordHumanWords } from "../src/config.js";
import { ActionRuntime } from "../src/action-runtime.js";
import { cycleAsideFocus, openAsideUseMenu } from "../src/aside-use.js";
import {
  insertComposerText,
  redoComposerEdit,
  setComposerText,
  undoComposerEdit
} from "../src/composer-model.js";
import { renderAsideScreen } from "../src/screens/story/aside-screen.js";
import { frameText, plainLine, visibleWidth } from "../src/screens/story/frame.js";
import { createStoryViewModel, rowIndexForNode } from "../src/model.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";
import type { StoryApi } from "../src/api.js";
import { storyApiFromWorkerTransport } from "../src/worker-story-api.js";

function session(turns: AsideSessionView["turns"]): AsideSessionView {
  return {
    id: "s1",
    title: "why the lantern",
    anchor: null,
    turns
  };
}

function surfaceWithTurns(turns: AsideSessionView["turns"]) {
  const source = demoAppSource();
  const state = initialState(source, false);
  const surface = createAsideSurface(
    state.payload.id,
    state.payload.title,
    [session(turns)],
    null,
    null,
    { v2: true }
  );
  if (!isAsideV2(surface)) throw new Error("expected an Aside session surface");
  state.aside = surface;
  state.mode = "ASIDE";
  return { source, state, surface: surface as AsideSessionSurfaceState };
}

describe("Aside v2 surface", () => {
  test("keeps a virtual legacy session visible and asks unanchored on an empty story", async () => {
    const source = demoAppSource();
    const emptyPayload = await source.api.createStory("empty story");
    const state = initialState({ ...source, payload: emptyPayload }, false);
    let readRequest: unknown;
    let askRequest: unknown;
    const api = {
      ...source.api,
      getAsideV2: async (request: unknown) => {
        readRequest = request;
        return {
          schemaVersion: 2 as const,
          anchor: null,
          sessions: [{
            id: "legacy",
            anchor: null,
            title: "Legacy",
            turns: [{ q: "Saved?", a: "Saved answer." }]
          }],
          anchors: [],
          unanchoredCount: 1
        };
      },
      askAsideV2: async (request: unknown) => {
        askRequest = request;
        return {
          schemaVersion: 2 as const,
          id: "legacy",
          anchor: null,
          title: "Legacy",
          turns: [
            { q: "Saved?", a: "Saved answer." },
            { q: "Next?", a: "Next answer." }
          ],
          payload: state.payload
        };
      }
    } as unknown as StoryApi;

    await openAside(state, api);
    expect(readRequest).toEqual({ storyId: emptyPayload.id, anchor: null });
    expect(state.aside).not.toBeNull();
    if (!isAsideV2(state.aside!)) throw new Error("expected an Aside session surface");
    expect(currentAsideTurns(state.aside)).toEqual([
      { q: "Saved?", a: "Saved answer." }
    ]);

    await sendAsideQuestion(state, api, "Next?");
    expect(askRequest).toEqual({
      storyId: emptyPayload.id,
      question: "Next?",
      anchor: null,
      sessionId: "legacy"
    });
  });

  test("sends only the canonical anchor fields to a worker-shaped reader", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const openingPart = state.payload.path.at(-1)!;
    state.focusIndex = rowIndexForNode(
      createStoryViewModel(state.payload),
      openingPart.id
    );
    let workerRequest: unknown;
    const api = {
      ...source.api,
      getAsideV2: async (request: { storyId: string; anchor: unknown }) => {
        workerRequest = request;
        const anchor = request.anchor;
        expect(anchor).toEqual({ partId: openingPart.id, takeId: openingPart.id });
        expect(Object.keys(anchor as object)).toEqual(["partId", "takeId"]);
        return {
          schemaVersion: 2 as const,
          anchor,
          sessions: [],
          anchors: [{ ...anchor as { partId: string; takeId: string }, sessionCount: 1 }],
          unanchoredCount: 0
        };
      }
    } as unknown as StoryApi;

    await openAside(state, api);
    expect(workerRequest).toEqual({
      storyId: state.payload.id,
      anchor: { partId: openingPart.id, takeId: openingPart.id }
    });
  });

  test("hydrates the opening take position for the Aside status and header", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const view = createStoryViewModel(state.payload);
    const openingPart = view.parts.at(-1)!;
    state.focusIndex = rowIndexForNode(view, openingPart.id);
    let askRequest: unknown;
    const api = {
      ...source.api,
      getAsideV2: async (request: { anchor: { partId: string; takeId: string } }) => ({
        schemaVersion: 2 as const,
        anchor: request.anchor,
        sessions: [{
          id: "s1",
          anchor: request.anchor,
          title: "why the lantern",
          turns: [{ q: "Why?", a: "Because." }]
        }],
        anchors: [{
          ...request.anchor,
          partNumber: openingPart.number,
          takeIndex: openingPart.takeIndex,
          takeCount: openingPart.siblingCount,
          sessionCount: 1
        }],
        unanchoredCount: 0
      }),
      askAsideV2: async (request: unknown) => {
        askRequest = request;
        return {
          schemaVersion: 2 as const,
          id: "s1",
          anchor: { partId: openingPart.id, takeId: openingPart.id },
          title: "why the lantern",
          turns: [
            { q: "Why?", a: "Because." },
            { q: "Next?", a: "Next answer." }
          ]
        };
      }
    } as unknown as StoryApi;

    await openAside(state, api);

    const aside = state.aside;
    if (aside === null || !isAsideV2(aside)) {
      throw new Error("expected an Aside session surface");
    }
    expect(aside.anchor).toEqual({
      partId: openingPart.id,
      takeId: openingPart.id,
      partNumber: openingPart.number,
      takeIndex: openingPart.takeIndex,
      takeCount: openingPart.siblingCount
    });
    const text = frameText(renderAsideScreen(state, aside, 120, 24).lines);
    expect(text).toContain(
      `¶ ${openingPart.number} · take ${openingPart.takeIndex}/${openingPart.siblingCount}`
    );
    expect(text).not.toContain("take ?/?");

    await sendAsideQuestion(state, api, "Next?");
    expect(askRequest).toEqual({
      storyId: state.payload.id,
      question: "Next?",
      anchor: { partId: openingPart.id, takeId: openingPart.id },
      sessionId: "s1"
    });
    expect(frameText(renderAsideScreen(state, aside, 120, 24).lines)).not.toContain("take ?/?");
  });

  test("keeps an empty unanchored canonical session in the v2 renderer", () => {
    const model = asideSessionsFromResponse({
      schemaVersion: 2,
      anchor: null,
      title: "new session",
      turns: []
    });
    expect(model.sessions).toHaveLength(1);
    const { surface } = surfaceWithTurns([]);
    expect(surface.modelVersion).toBe(2);
    expect(asideHistoryWindow(surface, 80, 3)).toContain("(ask about this story)");
  });

  test("materializes the unanchored count as the last hop entry", () => {
    const model = asideSessionsFromResponse({
      schemaVersion: 2,
      anchor: { partId: "part-2", takeId: "take-1" },
      sessions: [],
      anchors: [{ partId: "part-2", takeId: "take-1", sessionCount: 1 }],
      unanchoredCount: 3
    });
    const entries = asideHopEntries(model.anchors, null);
    expect(entries.at(-1)?.label).toBe("· unanchored ×3");
    expect(entries.at(-1)?.current).toBeTrue();
  });

  test("renders collapsed thoughts and a compact 80-column keyline", () => {
    const { surface } = surfaceWithTurns([{
      q: "Why?",
      a: "Because.",
      thoughts: "private reasoning",
      thoughtTokens: 7
    }]);
    const rows = asideHistoryWindow(surface, 80, 5, 1_000);
    expect(rows.join("\n")).toContain("Thought · 7 tok");
    expect(rows.join("\n")).not.toContain("private reasoning");
    expect(asideFooterHint(surface)).toContain("r retake");
  });

  test("Thought toggle survives a later human-word config update", async () => {
    const configHome = await mkdtemp(path.join(tmpdir(), "1667-aside-config-"));
    const priorConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = configHome;
    try {
      const { source, state, surface } = surfaceWithTurns([{ q: "Why?", a: "Because." }]);
      const backend = new ActionRuntime(state, () => undefined);
      await asideV2KeyAction(
        { action: "toggle-thought" },
        state,
        surface,
        { source, backend }
      );
      expect(state.config.asideThoughts).toBe("show");
      expect(source.config.asideThoughts).toBe("show");

      source.config = recordHumanWords(
        source.config,
        3,
        new Date("2026-08-25T12:00:00.000Z")
      );
      state.config = source.config;
      expect(state.config.asideThoughts).toBe("show");
      expect(state.config.quota.words).toBe(3);
    } finally {
      if (priorConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = priorConfigHome;
      await rm(configHome, { recursive: true, force: true });
    }
  });

  test("renders reserved-looking answer paragraphs as answers", () => {
    const { state, surface } = surfaceWithTurns([{
      q: "Why?",
      a: "› answer prose\n┊ answer prose\n⟳ answer prose"
    }]);
    const frame = renderAsideScreen(state, surface, 120, 36);
    for (const prefix of ["› answer prose", "┊ answer prose", "⟳ answer prose"]) {
      const line = frame.lines.find((candidate) =>
        candidate.some((part) => part.text.includes(prefix))
      );
      expect(line).toBeDefined();
      expect(line?.find((part) => part.text.includes(prefix))?.role).toBe("prose");
    }
  });

  test("labels both chat roles and gives questions a full-row treatment at wide and narrow widths", () => {
    const { state, surface } = surfaceWithTurns([{
      q: "Why does the lantern answer the traveler with such a long warning?",
      a: "Because the warning belongs to the road, not to the person carrying it."
    }]);
    for (const width of [80, 20]) {
      const frame = renderAsideScreen(state, surface, width, 24);
      const question = frame.lines.find((line) => plainLine(line).includes("You"));
      const answer = frame.lines.find((line) => plainLine(line).includes("Assistant"));
      expect(question).toBeDefined();
      expect(answer).toBeDefined();
      expect(question!.every((part) => part.background === "raised")).toBeTrue();
      expect(question!.some((part) => part.role === "human edit")).toBeTrue();
      expect(answer!.some((part) => part.role === "prose")).toBeTrue();
      expect(frame.lines.every((line) => visibleWidth(plainLine(line)) <= width)).toBeTrue();
      expect(frameText(frame.lines)).not.toContain("│");
    }
  });

  test("narrow wrapped answers reclaim the role-label gutter", () => {
    const { surface } = surfaceWithTurns([{
      q: "Why?",
      a: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
    }]);
    const layout = asideChatLayout(surface, 20, "");
    const answers = layout.body.filter((_, index) => layout.rowKinds[index] === "answer");

    expect(answers[0]).toBe("  Assistant abcdefgh");
    expect(answers[1]?.startsWith("  ")).toBeTrue();
    expect(answers[1]?.slice(2)).toHaveLength(18);
  });

  test("narrow answer content cannot be mistaken for its role label", () => {
    const answer = "abcdefghAssistant continues here";
    const { state, surface } = surfaceWithTurns([{ q: "Why?", a: answer }]);
    const width = 20;
    const layout = asideChatLayout(surface, width, "");
    const answerRows = layout.rowKinds.flatMap((kind, index) =>
      kind === "answer" ? [index] : []);
    expect(layout.body[answerRows[1]!]!.startsWith("  Assistant")).toBeTrue();
    expect(layout.rowRolePrefixes[answerRows[1]!]).toBe("  ");

    const frame = renderAsideScreen(state, surface, width, 24);
    const display = frame.derived.storySelectionProjection?.findIndex((cell) =>
      cell?.text === answer && cell.start === 8) ?? -1;
    expect(display).toBeGreaterThan(-1);
    expect(display % (width + 1)).toBe(2);
  });

  test("a scrolled answer keeps semantic selection ownership after focus decoration", () => {
    const { state, surface } = surfaceWithTurns([{
      q: "Why?",
      a: "answer-source-".repeat(30)
    }]);
    const layout = asideChatLayout(surface, 20, "");
    const firstAnswer = layout.rowKinds.indexOf("answer");
    const starts: number[] = [];

    for (const scrollTop of [firstAnswer, firstAnswer + 1]) {
      surface.scrollTop = scrollTop;
      const frame = renderAsideScreen(state, surface, 20, 10);
      const focused = frame.lines.find((line) => plainLine(line).startsWith("▸"));
      const owned = focused?.find((part) => part.storySource !== undefined);
      expect(owned).toBeDefined();
      expect(owned?.storySource?.text).toBe(currentAsideTurns(surface)[0]!.a);
      starts.push(owned!.storySource!.start);
    }
    expect(starts[1]!).toBeGreaterThan(starts[0]!);
  });

  test("deletes optimistically and restores without an API call", async () => {
    let deletes = 0;
    const { source, state, surface } = surfaceWithTurns([
      { q: "Why?", a: "Because." }
    ]);
    const api = {
      ...source.api,
      deleteAsideTurn: async () => { deletes += 1; }
    } as unknown as StoryApi;
    const backend = new ActionRuntime(state, () => undefined);
    const context = { source: { api, config: state.config }, backend, repaint: () => undefined };
    await asideV2KeyAction({ action: "aside-delete" }, state, surface, context);
    expect(currentAsideTurns(surface)).toHaveLength(1);
    expect(surface.confirmDelete).not.toBeNull();
    await asideV2KeyAction({ action: "cancel" }, state, surface, context);
    expect(currentAsideTurns(surface)).toHaveLength(1);
    expect(surface.confirmDelete).toBeNull();
    await asideV2KeyAction({ action: "aside-delete" }, state, surface, context);
    await asideV2KeyAction({ action: "aside-delete" }, state, surface, context);
    expect(currentAsideTurns(surface)).toHaveLength(0);
    expect(deletes).toBe(0);
    await asideV2KeyAction({ action: "aside-undo-delete" }, state, surface, context);
    expect(currentAsideTurns(surface)).toHaveLength(1);
    expect(deletes).toBe(0);
  });

  test("use-menu ownership still flushes an optimistic delete", async () => {
    const { source, state, surface } = surfaceWithTurns([
      { q: "First?", a: "One." },
      { q: "Second?", a: "Two." }
    ]);
    surface.focus = "turns";
    surface.turnCursor = 1;
    let deletes = 0;
    const api = {
      ...source.api,
      deleteAsideTurn: async () => {
        deletes += 1;
        return {
          schemaVersion: 2 as const,
          id: "s1",
          anchor: null,
          title: "why the lantern",
          turns: [{ q: "First?", a: "One." }]
        };
      }
    } as unknown as StoryApi;
    const backend = new ActionRuntime(state, () => undefined);
    const context = { source: { api, config: state.config }, backend };

    await asideV2KeyAction({ action: "aside-delete" }, state, surface, context);
    await asideV2KeyAction({ action: "aside-delete" }, state, surface, context);
    expect(surface.deleteUndo).not.toBeNull();
    expect(openAsideUseMenu(surface, 0)).toBeTrue();

    expect(await asideV2KeyAction(
      { action: "aside-retake-with-prompt" }, state, surface, context
    )).toBeFalse();
    expect(surface.retakePrompt).toBeNull();
    await backend.settle();
    expect(deletes).toBe(1);
    expect(surface.deleteUndo).toBeNull();
  });

  test("u during a durable delete does not restore the submitted turn", async () => {
    const { source, state, surface } = surfaceWithTurns([
      { q: "First?", a: "One." },
      { q: "Second?", a: "Two." }
    ]);
    surface.focus = "turns";
    surface.turnCursor = 1;
    let release!: () => void;
    let deletes = 0;
    const api = {
      ...source.api,
      deleteAsideTurn: async () => {
        deletes += 1;
        await new Promise<void>((resolve) => { release = resolve; });
        return {
          schemaVersion: 2 as const,
          id: "s1",
          anchor: null,
          title: "why the lantern",
          turns: [{ q: "First?", a: "One." }]
        };
      }
    } as unknown as StoryApi;
    const sourceWithApi = { ...source, api };
    const backend = new ActionRuntime(state, () => undefined);
    const key = (name: string) => ({
      name,
      sequence: name,
      shift: false,
      ctrl: false,
      meta: false
    }) as Parameters<typeof handleKey>[0];
    const press = (name: string) => handleKey(
      key(name), state, sourceWithApi, createWrapCache(), () => undefined,
      async () => undefined, () => undefined, null, () => undefined, () => undefined, backend
    );

    await press("D");
    await press("D");
    expect(surface.deleteUndo).not.toBeNull();
    await press("down");
    await Promise.resolve();
    expect(deletes).toBe(1);
    expect(surface.deleteUndo).toBeNull();
    await press("u");
    expect(currentAsideTurns(surface)).toEqual([{ q: "First?", a: "One." }]);
    release();
    await backend.settle();
    expect(currentAsideTurns(surface)).toEqual([{ q: "First?", a: "One." }]);
  });

  test("u after a successful durable delete cannot restore the turn", async () => {
    const { source, state, surface } = surfaceWithTurns([
      { q: "First?", a: "One." },
      { q: "Second?", a: "Two." }
    ]);
    surface.focus = "turns";
    surface.turnCursor = 1;
    const api = {
      ...source.api,
      deleteAsideTurn: async () => ({
        schemaVersion: 2 as const,
        id: "s1",
        anchor: null,
        title: "why the lantern",
        turns: [{ q: "First?", a: "One." }]
      })
    } as unknown as StoryApi;
    const sourceWithApi = { ...source, api };
    const backend = new ActionRuntime(state, () => undefined);
    const key = (name: string) => ({
      name,
      sequence: name,
      shift: false,
      ctrl: false,
      meta: false
    }) as Parameters<typeof handleKey>[0];
    const press = (name: string) => handleKey(
      key(name), state, sourceWithApi, createWrapCache(), () => undefined,
      async () => undefined, () => undefined, null, () => undefined, () => undefined, backend
    );

    await press("D");
    await press("D");
    await press("down");
    await backend.settle();
    expect(surface.deleteUndo).toBeNull();
    expect(currentAsideTurns(surface)).toEqual([{ q: "First?", a: "One." }]);
    await press("u");
    expect(currentAsideTurns(surface)).toEqual([{ q: "First?", a: "One." }]);
  });

  test("blocks a second delete while the first failure is in flight", async () => {
    const { source, state, surface } = surfaceWithTurns([
      { q: "A?", a: "A." },
      { q: "B?", a: "B." },
      { q: "C?", a: "C." }
    ]);
    surface.focus = "turns";
    surface.turnCursor = 2;
    const requests: unknown[] = [];
    let failFirst!: () => void;
    const api = {
      ...source.api,
      deleteAsideTurn: async (request: unknown) => {
        requests.push(request);
        if (requests.length === 1) {
          return await new Promise<never>((_resolve, reject) => {
            failFirst = () => reject(new Error("delete failed"));
          });
        }
        return {
          schemaVersion: 2 as const,
          id: "s1",
          anchor: null,
          title: "why the lantern",
          turns: [{ q: "A?", a: "A." }, { q: "C?", a: "C." }]
        };
      }
    } as unknown as StoryApi;
    const sourceWithApi = { ...source, api };
    const backend = new ActionRuntime(state, () => undefined);
    const key = (name: string) => ({
      name,
      sequence: name,
      shift: false,
      ctrl: false,
      meta: false
    }) as Parameters<typeof handleKey>[0];
    const press = (name: string) => handleKey(
      key(name), state, sourceWithApi, createWrapCache(), () => undefined,
      async () => undefined, () => undefined, null, () => undefined, () => undefined, backend
    );

    await press("D");
    await press("D");
    await press("down");
    await Promise.resolve();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ sessionId: "s1", turnIndex: 2 });
    expect(surface.deleteUndo).toBeNull();

    await press("D");
    expect(currentAsideTurns(surface)).toEqual([
      { q: "A?", a: "A." },
      { q: "B?", a: "B." }
    ]);
    expect(surface.deleteUndo).toBeNull();

    failFirst();
    await backend.settle();
    expect(currentAsideTurns(surface)).toEqual([
      { q: "A?", a: "A." },
      { q: "B?", a: "B." },
      { q: "C?", a: "C." }
    ]);

    await press("up");
    await press("D");
    await press("D");
    await press("down");
    await backend.settle();
    expect(requests[1]).toMatchObject({ sessionId: "s1", turnIndex: 1 });
    expect(currentAsideTurns(surface)).toEqual([
      { q: "A?", a: "A." },
      { q: "C?", a: "C." }
    ]);
  });

  test("failed delete restores its session without stealing a later selection", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const surface = createAsideSurface(
      state.payload.id,
      state.payload.title,
      [
        {
          id: "s1",
          title: "first",
          anchor: null,
          turns: [{ q: "A?", a: "A." }, { q: "B?", a: "B." }]
        },
        { id: "s2", title: "second", anchor: null, turns: [{ q: "C?", a: "C." }] }
      ],
      null,
      null,
      { v2: true, sessionIndex: 0 }
    );
    if (!isAsideV2(surface)) throw new Error("expected an Aside session surface");
    surface.focus = "turns";
    surface.turnCursor = 1;
    state.aside = surface;
    state.mode = "ASIDE";
    let rejectDelete!: (error: Error) => void;
    const api = {
      ...source.api,
      deleteAsideTurn: async () => await new Promise<never>((_resolve, reject) => {
        rejectDelete = reject;
      })
    } as unknown as StoryApi;
    const sourceWithApi = { ...source, api };
    const backend = new ActionRuntime(state, () => undefined);
    const key = (name: string) => ({
      name,
      sequence: name,
      shift: false,
      ctrl: false,
      meta: false
    }) as Parameters<typeof handleKey>[0];
    const press = (name: string) => handleKey(
      key(name),
      state,
      sourceWithApi,
      createWrapCache(),
      () => undefined,
      async () => undefined,
      () => undefined,
      null,
      () => undefined,
      () => undefined,
      backend
    );

    await press("D");
    await press("D");
    expect(currentAsideTurns(surface)).toEqual([{ q: "A?", a: "A." }]);
    await press("right");
    await Promise.resolve();
    expect(surface.sessionIndex).toBe(1);
    expect(surface.turnCursor).toBe(0);
    rejectDelete(new Error("delete failed"));
    await backend.settle();

    expect(surface.sessionIndex).toBe(1);
    expect(surface.turnCursor).toBe(0);
    expect(currentAsideTurns(surface)).toEqual([{ q: "C?", a: "C." }]);
    expect(surface.sessions[0]?.turns).toEqual([
      { q: "A?", a: "A." },
      { q: "B?", a: "B." }
    ]);
  });

  test("failed delete after closing Aside remains observable and reopens authoritative turns", async () => {
    const { source, state, surface } = surfaceWithTurns([
      { q: "A?", a: "A." },
      { q: "B?", a: "B." }
    ]);
    surface.focus = "turns";
    surface.turnCursor = 1;
    let rejectDelete!: (error: Error) => void;
    const api = {
      ...source.api,
      deleteAsideTurn: async () => await new Promise<never>((_resolve, reject) => {
        rejectDelete = reject;
      }),
      getAsideV2: async () => ({
        schemaVersion: 2 as const,
        anchor: null,
        sessions: [{
          id: "s1",
          title: "why the lantern",
          anchor: null,
          turns: [{ q: "A?", a: "A." }, { q: "B?", a: "B." }]
        }],
        anchors: [],
        unanchoredCount: 1
      })
    } as unknown as StoryApi;
    const sourceWithApi = { ...source, api };
    const backend = new ActionRuntime(state, () => undefined);
    const key = (name: string) => ({
      name,
      sequence: name,
      shift: false,
      ctrl: false,
      meta: false
    }) as Parameters<typeof handleKey>[0];
    const press = (name: string) => handleKey(
      key(name),
      state,
      sourceWithApi,
      createWrapCache(),
      () => undefined,
      async () => undefined,
      () => undefined,
      null,
      () => undefined,
      () => undefined,
      backend
    );

    await press("D");
    await press("D");
    expect(currentAsideTurns(surface)).toEqual([{ q: "A?", a: "A." }]);
    await press("escape");
    expect(state.aside).toBeNull();
    await Promise.resolve();
    rejectDelete(new Error("delete failed"));
    await backend.settle();
    expect(state.toast).toBe("delete failed");

    await openAside(state, api, { entryPointsOpen: true });
    expect(state.aside).not.toBeNull();
    expect(currentAsideTurns(state.aside!)).toEqual([
      { q: "A?", a: "A." },
      { q: "B?", a: "B." }
    ]);
  });

  test("clears the v2 session through its typed method with a null anchor", async () => {
    const { source, state, surface } = surfaceWithTurns([
      { q: "Why?", a: "Because." }
    ]);
    let request: unknown;
    let legacyClears = 0;
    const api = {
      ...source.api,
      clearAsideSession: async (value: unknown) => {
        request = value;
        return {
          schemaVersion: 2 as const,
          id: "s1",
          anchor: null,
          title: "why the lantern",
          turns: []
        };
      },
      clearAside: async () => {
        legacyClears += 1;
        return state.payload;
      }
    } as StoryApi;
    const backend = new ActionRuntime(state, () => undefined);
    const context = { source: { api, config: state.config }, backend, repaint: () => undefined };

    surface.composer.text = "/clear";
    await asideV2KeyAction({ action: "send" }, state, surface, context);
    await backend.settle();
    expect(surface.confirmReset).toEqual({ turnIndex: -1 });
    await asideV2KeyAction({ action: "send" }, state, surface, context);
    await backend.settle();

    expect(request).toEqual({
      storyId: state.payload.id,
      sessionId: "s1",
      anchor: null
    });
    expect(legacyClears).toBe(0);
    expect(currentAsideTurns(surface)).toHaveLength(0);
  });

  test("asks into the same durable session after it was cleared", async () => {
    const { source, state, surface } = surfaceWithTurns([]);
    let request: unknown;
    const api = {
      ...source.api,
      askAsideV2: async (value: unknown) => {
        request = value;
        return {
          schemaVersion: 2 as const,
          id: "s1",
          anchor: null,
          title: "why the lantern",
          turns: [{ q: "Again?", a: "Again." }],
          payload: state.payload
        };
      }
    } as unknown as StoryApi;

    await sendAsideQuestion(state, api, "Again?");

    expect(request).toEqual({
      storyId: state.payload.id,
      question: "Again?",
      anchor: null,
      sessionId: "s1"
    });
    expect(currentAsideTurns(surface)).toHaveLength(1);
  });

  test("reconciles first ask presence and keeps the opening take projection", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const openingAnchor = {
      partId: "part-1",
      takeId: "take-1",
      partNumber: 2,
      takeIndex: 1,
      takeCount: 2
    };
    const surface = createAsideSurface(
      state.payload.id,
      state.payload.title,
      [],
      null,
      null,
      { v2: true, anchor: openingAnchor }
    );
    if (!isAsideV2(surface)) throw new Error("expected an Aside session surface");
    state.aside = surface;
    state.mode = "ASIDE";
    const payload = {
      ...state.payload,
      asidePresence: {
        anchors: [{ partId: openingAnchor.partId, takeId: openingAnchor.takeId, sessionCount: 1 }],
        unanchoredCount: 0
      }
    };
    let request: unknown;
    const api = {
      ...source.api,
      askAsideV2: async (value: unknown) => {
        request = value;
        return {
          schemaVersion: 2 as const,
          id: "s1",
          anchor: { partId: openingAnchor.partId, takeId: openingAnchor.takeId },
          title: "new session",
          turns: [{ q: "First?", a: "First answer." }],
          payload
        };
      }
    } as unknown as StoryApi;

    await sendAsideQuestion(state, api, "First?");

    expect(request).toEqual({
      storyId: state.payload.id,
      question: "First?",
      anchor: { partId: openingAnchor.partId, takeId: openingAnchor.takeId }
    });
    expect(surface.anchors).toEqual([{
      ...openingAnchor,
      sessionCount: 1
    }]);
    expect(surface.anchor).toEqual({
      ...openingAnchor
    });
    expect(surface.anchorIndex).toBe(0);
  });

  test("settles a single session response by id and keeps the full hop index", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const anchors = [
      { partId: "part-0", takeId: "take-0", sessionCount: 1, partNumber: 1, takeIndex: 0, takeCount: 3 },
      { partId: "part-1", takeId: "take-1", sessionCount: 2, partNumber: 1, takeIndex: 1, takeCount: 3 },
      { partId: "part-2", takeId: "take-2", sessionCount: 1, partNumber: 2, takeIndex: 0, takeCount: 1 }
    ];
    const currentAnchor = { partId: "part-1", takeId: "take-1" };
    const surface = createAsideSurface(
      state.payload.id,
      state.payload.title,
      [
        { id: "s0", title: "first", anchor: anchors[0]!, turns: [{ q: "old 0", a: "answer 0" }] },
        { id: "s1", title: "current", anchor: currentAnchor, turns: [{ q: "old 1", a: "answer 1" }] },
        { id: "s2", title: "last", anchor: anchors[2]!, turns: [{ q: "old 2", a: "answer 2" }] }
      ],
      null,
      null,
      { v2: true, anchors, anchor: currentAnchor, sessionIndex: 1 }
    );
    state.aside = surface;
    state.mode = "ASIDE";
    const api = {
      ...source.api,
      askAsideV2: async () => ({
        schemaVersion: 2 as const,
        id: "s1",
        anchor: currentAnchor,
        title: "current",
        turns: [{ q: "new question", a: "new answer" }],
        payload: state.payload
      }),
      resetAside: async () => ({
        schemaVersion: 2 as const,
        id: "s1",
        anchor: currentAnchor,
        title: "current",
        turns: [{ q: "reset question", a: "reset answer" }],
        payload: state.payload
      })
    } as unknown as StoryApi;

    await sendAsideQuestion(state, api, "new question");

    expect(surface.sessionIndex).toBe(1);
    expect(surface.sessions.map((entry) => entry.title)).toEqual(["first", "current", "last"]);
    expect(currentAsideTurns(surface)).toEqual([{ q: "new question", a: "new answer" }]);
    expect(surface.anchors).toHaveLength(3);
    expect(surface.anchors.map((entry) => [entry.partId, entry.takeId, entry.sessionCount]))
      .toEqual(anchors.map((entry) => [entry.partId, entry.takeId, entry.sessionCount]));
    expect(surface.anchor).toEqual({
      ...currentAnchor,
      partNumber: 1,
      takeIndex: 1,
      takeCount: 3
    });

    surface.sessions[1] = {
      ...surface.sessions[1]!,
      turns: [
        { q: "reset question", a: "old answer" },
        { q: "later question", a: "later answer" }
      ]
    };
    surface.turnCursor = 0;
    surface.confirmReset = { turnIndex: 0 };
    const backend = new ActionRuntime(state, () => undefined);
    await asideV2KeyAction(
      { action: "aside-reset" },
      state,
      surface,
      { source: { api, config: state.config }, backend, repaint: () => undefined }
    );
    await backend.settle();

    expect(surface.sessionIndex).toBe(1);
    expect(currentAsideTurns(surface)).toEqual([{ q: "reset question", a: "reset answer" }]);
    expect(surface.anchors).toHaveLength(3);
  });

  test("accepts a pending reset after Up changes interaction state", async () => {
    const { source, state, surface } = surfaceWithTurns([
      { q: "Keep?", a: "Keep." },
      { q: "Drop?", a: "Drop." }
    ]);
    surface.focus = "turns";
    surface.turnCursor = 0;
    let release!: () => void;
    const api = {
      ...source.api,
      resetAside: async () => {
        await new Promise<void>((resolve) => { release = resolve; });
        return {
          schemaVersion: 2 as const,
          id: "s1",
          anchor: null,
          title: "why the lantern",
          turns: [{ q: "Keep?", a: "Keep." }]
        };
      }
    } as unknown as StoryApi;
    const sourceWithApi = { ...source, api };
    const backend = new ActionRuntime(state, () => undefined);
    const key = (name: string) => ({
      name,
      sequence: name,
      shift: false,
      ctrl: false,
      meta: false
    }) as Parameters<typeof handleKey>[0];
    const press = (name: string) => handleKey(
      key(name), state, sourceWithApi, createWrapCache(), () => undefined,
      async () => undefined, () => undefined, null, () => undefined, () => undefined, backend
    );

    await press("backspace");
    await press("backspace");
    await Promise.resolve();
    expect(surface.confirmReset).toEqual({ turnIndex: 0 });
    await press("up");
    release();
    await backend.settle();
    expect(currentAsideTurns(surface)).toEqual([{ q: "Keep?", a: "Keep." }]);
    expect(surface.confirmReset).toBeNull();
  });

  test("accepts a pending clear after Thoughts toggles", async () => {
    const { source, state, surface } = surfaceWithTurns([{ q: "Why?", a: "Because." }]);
    surface.focus = "composer";
    surface.composer.text = "/clear";
    let release!: () => void;
    const api = {
      ...source.api,
      clearAsideSession: async () => {
        await new Promise<void>((resolve) => { release = resolve; });
        return {
          schemaVersion: 2 as const,
          id: "s1",
          anchor: null,
          title: "why the lantern",
          turns: []
        };
      }
    } as unknown as StoryApi;
    const sourceWithApi = { ...source, api };
    const backend = new ActionRuntime(state, () => undefined);
    const key = (name: string) => ({
      name,
      sequence: name,
      shift: false,
      ctrl: false,
      meta: false
    }) as Parameters<typeof handleKey>[0];
    const press = (name: string) => handleKey(
      key(name), state, sourceWithApi, createWrapCache(), () => undefined,
      async () => undefined, () => undefined, null, () => undefined, () => undefined, backend
    );

    await press("return");
    await press("return");
    await Promise.resolve();
    await press("tab");
    await press("t");
    expect(surface.thoughtsVisible).toBeTrue();
    release();
    await backend.settle();
    expect(currentAsideTurns(surface)).toEqual([]);
    expect(surface.confirmReset).toBeNull();
  });

  test("keeps existing sessions reachable from a new empty session", async () => {
    const { source, state, surface } = surfaceWithTurns([{ q: "Why?", a: "Because." }]);
    surface.focus = "turns";
    const backend = new ActionRuntime(state, () => undefined);
    const key = (name: string) => ({
      name,
      sequence: name,
      shift: false,
      ctrl: false,
      meta: false
    }) as Parameters<typeof handleKey>[0];
    const press = (name: string) => handleKey(
      key(name), state, source, createWrapCache(), () => undefined,
      async () => undefined, () => undefined, null, () => undefined, () => undefined, backend
    );

    await press("n");
    expect(surface.sessions).toHaveLength(2);
    expect(surface.sessionIndex).toBe(1);
    expect(currentAsideTurns(surface)).toEqual([]);
    await press("left");
    expect(surface.sessionIndex).toBe(0);
    expect(currentAsideTurns(surface)).toEqual([{ q: "Why?", a: "Because." }]);
    await press("right");
    expect(surface.sessionIndex).toBe(1);
    expect(currentAsideTurns(surface)).toEqual([]);
  });

  test("Esc closes the composer before a second Esc exits Aside", async () => {
    const { source, state, surface } = surfaceWithTurns([{ q: "Why?", a: "Because." }]);
    surface.focus = "composer";
    surface.composer.text = "unsent draft";
    const backend = new ActionRuntime(state, () => undefined);
    const key = (name: string) => ({
      name,
      sequence: name,
      shift: false,
      ctrl: false,
      meta: false
    }) as Parameters<typeof handleKey>[0];
    const press = (name: string) => handleKey(
      key(name), state, source, createWrapCache(), () => undefined,
      async () => undefined, () => undefined, null, () => undefined, () => undefined, backend
    );

    await press("escape");
    expect(surface.focus).toBe("turns");
    expect(state.mode).toBe("ASIDE");
    expect(surface.composer.text).toBe("unsent draft");
    await press("tab");
    expect(surface.focus).toBe("composer");
    await press("escape");
    expect(surface.focus).toBe("turns");
    expect(surface.composer.text).toBe("unsent draft");
    await press("escape");
    expect(state.mode).toBe("NAV");
    expect(state.aside).toBeNull();
  });

  test("capital R edits the newest question and restores the ask draft", async () => {
    const { source, state, surface } = surfaceWithTurns([{ q: "Why?", a: "Because." }]);
    surface.focus = "turns";
    surface.composer.text = "Follow-up draft";
    surface.composer.cursor = surface.composer.text.length;
    let request: unknown;
    const api = {
      ...source.api,
      retakeAside: async (next: unknown) => {
        request = next;
        return {
          schemaVersion: 2 as const,
          id: "s1",
          anchor: null,
          title: "What changed?",
          turns: [{ q: "What changed?", a: "A better answer." }]
        };
      }
    } as unknown as StoryApi;
    const sourceWithApi = { ...source, api };
    const backend = new ActionRuntime(state, () => undefined);
    const key = (name: string) => ({
      name,
      sequence: name,
      shift: name === "R",
      ctrl: false,
      meta: false
    }) as Parameters<typeof handleKey>[0];
    const press = (name: string) => handleKey(
      key(name), state, sourceWithApi, createWrapCache(), () => undefined,
      async () => undefined, () => undefined, null, () => undefined, () => undefined, backend
    );

    expect(openAsideUseMenu(surface, 0)).toBeTrue();
    await press("R");
    expect(surface.useMenu).not.toBeNull();
    expect(surface.retakePrompt).toBeNull();
    await press("escape");
    expect(surface.useMenu).toBeNull();

    await press("R");
    expect(surface.focus).toBe("composer");
    expect(surface.composer.text).toBe("Why?");
    expect(surface.retakePrompt?.sessionId).toBe("s1");
    expect(surface.retakePrompt?.turnIndex).toBe(0);
    expect(surface.retakePrompt?.askComposer).not.toBeNull();
    expect(surface.retakePrompt?.askComposer).not.toBe(surface.composer);
    expect(openAsideUseMenu(surface, 0)).toBeFalse();
    expect(surface.useMenu).toBeNull();

    await press("escape");
    expect(surface.focus).toBe("turns");
    expect(surface.retakePrompt).toBeNull();
    expect(surface.composer.text).toBe("Follow-up draft");

    await press("R");

    surface.composer.text = "What changed?";
    surface.composer.cursor = surface.composer.text.length;
    await press("return");
    await backend.settle();

    expect(request).toMatchObject({
      storyId: state.payload.id,
      sessionId: "s1",
      turnIndex: 0,
      anchor: null,
      question: "What changed?"
    });
    expect(currentAsideTurns(surface)).toEqual([
      { q: "What changed?", a: "A better answer." }
    ]);
    expect(surface.focus).toBe("turns");
    expect(surface.retakePrompt).toBeNull();
    expect(surface.composer.text).toBe("Follow-up draft");
  });

  test("reprompt restores the complete Ask composer, including edit history", async () => {
    const { source, state, surface } = surfaceWithTurns([{ q: "Why?", a: "Because." }]);
    const askComposer = surface.composer;
    setComposerText(askComposer, "Follow-up draft");
    insertComposerText(askComposer, "!");
    insertComposerText(askComposer, "?");
    expect(undoComposerEdit(askComposer)).toBeTrue();
    askComposer.cursor = 3;
    askComposer.anchor = 1;
    askComposer.fullscreen = true;
    askComposer.cutConfirmation = { start: 1, end: 3, text: "ol" };
    const before = {
      text: askComposer.text,
      cursor: askComposer.cursor,
      anchor: askComposer.anchor,
      fullscreen: askComposer.fullscreen,
      cutConfirmation: { ...askComposer.cutConfirmation }
    };
    surface.focus = "turns";
    const api = {
      ...source.api,
      retakeAside: async () => ({
        schemaVersion: 2 as const,
        id: "s1",
        anchor: null,
        title: "Why?",
        turns: [{ q: "Why?", a: "A new answer." }]
      })
    } as unknown as StoryApi;
    const backend = new ActionRuntime(state, () => undefined);
    const press = (name: string) => asideV2KeyAction(
      { action: name === "R" ? "aside-retake-with-prompt" : "cancel" },
      state,
      surface,
      { source: { api, config: state.config }, backend }
    );

    await press("R");
    expect(surface.composer).not.toBe(askComposer);
    expect(surface.composer.text).toBe("Why?");
    await press("escape");

    expect(surface.composer).toBe(askComposer);
    expect({
      text: askComposer.text,
      cursor: askComposer.cursor,
      anchor: askComposer.anchor,
      fullscreen: askComposer.fullscreen,
      cutConfirmation: askComposer.cutConfirmation
    }).toEqual(before);
    expect(undoComposerEdit(askComposer)).toBeTrue();
    expect(askComposer.text).toBe("Follow-up draft");
    expect(redoComposerEdit(askComposer)).toBeTrue();
    expect(askComposer.text).toBe("Follow-up draft!");
  });

  test("empty current buckets use brackets for anchor hops", async () => {
    const { source, state, surface } = surfaceWithTurns([]);
    const first = { partId: "part-1", takeId: "take-1", sessionCount: 1 };
    const second = { partId: "part-2", takeId: "take-2", sessionCount: 1 };
    surface.sessions[0] = { ...surface.sessions[0]!, anchor: first };
    surface.anchor = first;
    surface.anchors = [first, second];
    surface.anchorIndex = 0;
    surface.focus = "composer";
    surface.composer.cursor = surface.composer.text.length;
    let hops = 0;
    const api = {
      ...source.api,
      getAsideV2: async (request: { anchor: unknown }) => {
        hops += 1;
        expect(request.anchor).toEqual({ partId: second.partId, takeId: second.takeId });
        return {
          schemaVersion: 2 as const,
          anchor: second,
          sessions: [{ id: "s2", title: "second", anchor: second, turns: [{ q: "Q", a: "A" }] }],
          anchors: [first, second]
        };
      }
    } as unknown as StoryApi;
    const sourceWithApi = { ...source, api };
    const backend = new ActionRuntime(state, () => undefined);
    const key = (name: string) => ({
      name,
      sequence: name,
      shift: false,
      ctrl: false,
      meta: false
    }) as Parameters<typeof handleKey>[0];
    const press = (name: string) => handleKey(
      key(name), state, sourceWithApi, createWrapCache(), () => undefined,
      async () => undefined, () => undefined, null, () => undefined, () => undefined, backend
    );

    surface.composer.text = "draft";
    surface.composer.cursor = surface.composer.text.length;
    await press("]");
    expect(hops).toBe(0);
    expect(surface.composer.text).toBe("draft]");
    surface.composer.text = "";
    surface.composer.cursor = 0;
    await press("]");
    await backend.settle();
    expect(hops).toBe(1);
    expect(surface.anchor).toEqual({ partId: second.partId, takeId: second.takeId });
    expect(currentAsideTurns(surface)).toEqual([{ q: "Q", a: "A" }]);
  });

  test("brackets hop to a sole different bucket and stay literal when current", async () => {
    const { source, state, surface } = surfaceWithTurns([]);
    const stale = { partId: "part-a", takeId: "take-a", sessionCount: 1 };
    const unanchored = {
      partId: "__aside_unanchored__",
      takeId: "__aside_unanchored__",
      sessionCount: 1,
      unanchored: true
    };
    surface.sessions[0] = { ...surface.sessions[0]!, anchor: stale };
    surface.anchor = stale;
    surface.anchors = [unanchored];
    surface.anchorIndex = 0;
    surface.focus = "composer";
    surface.composer.text = "";
    surface.composer.cursor = 0;
    let hops = 0;
    const api = {
      ...source.api,
      getAsideV2: async () => {
        hops += 1;
        return {
          schemaVersion: 2 as const,
          anchor: null,
          sessions: [{ id: "legacy", title: "legacy", anchor: null, turns: [] }],
          anchors: [unanchored]
        };
      }
    } as unknown as StoryApi;
    const sourceWithApi = { ...source, api };
    const backend = new ActionRuntime(state, () => undefined);
    const key = (name: string) => ({
      name,
      sequence: name,
      shift: false,
      ctrl: false,
      meta: false
    }) as Parameters<typeof handleKey>[0];
    const press = (name: string) => handleKey(
      key(name), state, sourceWithApi, createWrapCache(), () => undefined,
      async () => undefined, () => undefined, null, () => undefined, () => undefined, backend
    );

    await press("]");
    await backend.settle();
    expect(hops).toBe(1);
    expect(surface.anchor).toBeNull();

    await press("]");
    expect(hops).toBe(1);
    expect(surface.composer.text).toBe("]");
  });

  test("hops from an absent current anchor at the correct edge", async () => {
    const { source, state, surface } = surfaceWithTurns([]);
    const stale = { partId: "part-a", takeId: "take-a", sessionCount: 1 };
    const first = { partId: "part-b", takeId: "take-b", sessionCount: 1 };
    const last = { partId: "part-c", takeId: "take-c", sessionCount: 1 };
    surface.sessions[0] = { ...surface.sessions[0]!, anchor: stale };
    surface.anchor = stale;
    surface.anchors = [first, last];
    surface.anchorIndex = 0;
    surface.focus = "composer";
    surface.composer.text = "";
    surface.composer.cursor = 0;
    const requests: unknown[] = [];
    const api = {
      ...source.api,
      getAsideV2: async (request: { anchor: { partId: string; takeId: string } }) => {
        requests.push(request.anchor);
        const anchor = request.anchor.partId === first.partId ? first : last;
        return {
          schemaVersion: 2 as const,
          anchor,
          sessions: [{ id: anchor.takeId, title: anchor.takeId, anchor, turns: [] }],
          anchors: [first, last]
        };
      }
    } as unknown as StoryApi;
    const sourceWithApi = { ...source, api };
    const backend = new ActionRuntime(state, () => undefined);
    const key = (name: string) => ({
      name,
      sequence: name,
      shift: false,
      ctrl: false,
      meta: false
    }) as Parameters<typeof handleKey>[0];
    const press = (name: string) => handleKey(
      key(name), state, sourceWithApi, createWrapCache(), () => undefined,
      async () => undefined, async () => undefined, null, () => undefined, () => undefined, backend
    );

    await press("]");
    await backend.settle();
    expect(requests[0]).toEqual({ partId: first.partId, takeId: first.takeId });
    expect(surface.anchor).toEqual({ partId: first.partId, takeId: first.takeId });

    await press("[");
    await backend.settle();
    expect(requests[1]).toEqual({ partId: last.partId, takeId: last.takeId });
    expect(surface.anchor).toEqual({ partId: last.partId, takeId: last.takeId });
  });

  test("retake owns the shared abort controller so Esc stops it", async () => {
    const { source, state, surface } = surfaceWithTurns([
      { q: "Why?", a: "Because." }
    ]);
    let requestSignal: AbortSignal | undefined;
    const api = {
      ...source.api,
      retakeAside: async (
        _request: unknown,
        _onDelta: (text: string) => void,
        callbacks: {
          onReasoning?: (delta: { text: string; tokenCount: number }) => void;
          onReasoningStopped?: (text: string) => void;
        },
        signal: AbortSignal
      ) => await new Promise<null>((resolve) => {
        callbacks.onReasoning?.({ text: "private", tokenCount: 7 });
        callbacks.onReasoningStopped?.(" tail");
        requestSignal = signal;
        signal.addEventListener("abort", () => resolve(null), { once: true });
      })
    } as unknown as StoryApi;
    const backend = new ActionRuntime(state, () => undefined);
    const pending = asideV2KeyAction(
      { action: "aside-retake" },
      state,
      surface,
      { source: { api, config: state.config }, backend, repaint: () => undefined }
    );
    await Promise.resolve();
    expect(surface.busy).toBeTrue();
    expect(surface.streamThoughts).toBe("private tail");
    expect(surface.streamThoughtTokens).toBe(7);
    expect(stopAsideAsk(state)).toBeTrue();
    expect(requestSignal?.aborted).toBeTrue();
    await pending;
    await backend.settle();
    expect(state.abort).toBeNull();
    expect(surface.busy).toBeFalse();
    expect(surface.streamThoughts).toBe("");
    expect(surface.streamThoughtTokens).toBe(0);
  });

  test("stopping a retake freezes its visible answer prefix", async () => {
    const { source, state, surface } = surfaceWithTurns([
      { q: "Why?", a: "Because." }
    ]);
    let emitDelta!: (text: string) => void;
    let finish!: (value: unknown) => void;
    const api = {
      ...source.api,
      retakeAside: async (
        _request: unknown,
        onDelta: (text: string) => void
      ) => {
        emitDelta = onDelta;
        return await new Promise<unknown>((resolve) => { finish = resolve; });
      }
    } as unknown as StoryApi;
    const backend = new ActionRuntime(state, () => undefined);
    const pending = asideV2KeyAction(
      { action: "aside-retake" },
      state,
      surface,
      { source: { api, config: state.config }, backend }
    );
    await Promise.resolve();
    emitDelta("VISIBLE prefix");
    expect(frameText(renderAsideScreen(state, surface, 80, 24).lines))
      .toContain("VISIBLE");

    expect(stopAsideAsk(state)).toBeTrue();
    emitDelta(" TAIL");
    const stopped = frameText(renderAsideScreen(state, surface, 80, 24).lines);
    expect(stopped).toContain("VISIBLE");
    expect(stopped).not.toContain("TAIL");

    finish({
      schemaVersion: 2 as const,
      id: "s1",
      anchor: null,
      title: "Why?",
      turns: [{ q: "Why?", a: "Committed replacement." }]
    });
    await pending;
    await backend.settle();
    expect(currentAsideTurns(surface)).toEqual([
      { q: "Why?", a: "Committed replacement." }
    ]);
    expect(surface.streamText).toBe("");
  });

  test("dispatched Esc stops a busy retake before moving focus to the composer", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const surface = createAsideSurface(
      state.payload.id,
      state.payload.title,
      [{ id: "s1", title: "why", anchor: null, turns: [{ q: "Why?", a: "Because." }] }],
      null,
      null,
      { v2: true }
    );
    if (!isAsideV2(surface)) throw new Error("expected an Aside session surface");
    surface.focus = "turns";
    state.aside = surface;
    state.mode = "ASIDE";
    let aborted = false;
    const api = {
      ...source.api,
      retakeAside: async (
        _request: unknown,
        _onDelta: (text: string) => void,
        _callbacks: unknown,
        signal: AbortSignal
      ) => await new Promise<null>((resolve) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          resolve(null);
        }, { once: true });
      })
    } as unknown as StoryApi;
    const sourceWithApi = { ...source, api };
    const backend = new ActionRuntime(state, () => undefined);
    const key = (name: string) => ({
      name,
      sequence: name,
      shift: false,
      ctrl: false,
      meta: false
    }) as Parameters<typeof handleKey>[0];
    const press = (name: string) => handleKey(
      key(name),
      state,
      sourceWithApi,
      createWrapCache(),
      () => undefined,
      async () => undefined,
      () => undefined,
      null,
      () => undefined,
      () => undefined,
      backend
    );

    const pending = press("r");
    await Promise.resolve();
    expect(surface.busy).toBeTrue();
    expect(surface.focus).toBe("turns");

    await press("escape");

    expect(aborted).toBeTrue();
    expect(surface.focus).toBe("turns");
    expect(state.mode).toBe("ASIDE");
    await pending;
    await backend.settle();
    expect(surface.busy).toBeFalse();
  });

  test("actual hop key fetches a sole unanchored bucket when the anchor differs", async () => {
    const { source, state, surface } = surfaceWithTurns([{ q: "Why?", a: "Because." }]);
    surface.focus = "turns";
    surface.anchor = { partId: "missing", takeId: "missing" };
    surface.anchors = [{
      partId: "__aside_unanchored__",
      takeId: "__aside_unanchored__",
      sessionCount: 1,
      unanchored: true
    }];
    surface.anchorIndex = 0;
    let request: unknown;
    const api = {
      ...source.api,
      getAsideV2: async (value: unknown) => {
        request = value;
        return {
          schemaVersion: 2 as const,
          anchor: null,
          sessions: [{
            id: "legacy",
            title: "legacy",
            anchor: null,
            turns: [{ q: "Saved?", a: "Saved." }]
          }],
          anchors: [{
            partId: "__aside_unanchored__",
            takeId: "__aside_unanchored__",
            sessionCount: 1,
            unanchored: true
          }]
        };
      }
    } as unknown as StoryApi;
    const sourceWithApi = { ...source, api };
    const backend = new ActionRuntime(state, () => undefined);
    const key = (name: string) => ({
      name,
      sequence: name,
      shift: false,
      ctrl: false,
      meta: false
    }) as Parameters<typeof handleKey>[0];

    await handleKey(
      key("]"),
      state,
      sourceWithApi,
      createWrapCache(),
      () => undefined,
      async () => undefined,
      () => undefined,
      null,
      () => undefined,
      () => undefined,
      backend
    );
    await backend.settle();

    expect(request).toEqual({ storyId: state.payload.id, anchor: null });
    expect(surface.anchor).toBeNull();
    expect(currentAsideTurns(surface)).toEqual([{ q: "Saved?", a: "Saved." }]);
  });

  test("actual Thought toggle does not discard a committed retake", async () => {
    const { source, state, surface } = surfaceWithTurns([{ q: "Why?", a: "Because." }]);
    surface.focus = "turns";
    let finish!: (value: unknown) => void;
    const api = {
      ...source.api,
      retakeAside: async (
        _request: unknown,
        _onDelta: (text: string) => void,
        _callbacks: unknown,
        _signal: AbortSignal
      ) => await new Promise<unknown>((resolve) => { finish = resolve; })
    } as unknown as StoryApi;
    const sourceWithApi = { ...source, api };
    const backend = new ActionRuntime(state, () => undefined);
    const key = (name: string) => ({
      name,
      sequence: name,
      shift: false,
      ctrl: false,
      meta: false
    }) as Parameters<typeof handleKey>[0];
    const press = (name: string) => handleKey(
      key(name),
      state,
      sourceWithApi,
      createWrapCache(),
      () => undefined,
      async () => undefined,
      () => undefined,
      null,
      () => undefined,
      () => undefined,
      backend
    );

    const retake = press("r");
    await Promise.resolve();
    expect(surface.busy).toBeTrue();
    await press("t");
    expect(surface.thoughtsVisible).toBeTrue();
    finish({
      schemaVersion: 2 as const,
      id: "s1",
      anchor: null,
      title: "why",
      turns: [{ q: "Why?", a: "Retaken." }]
    });
    await retake;
    await backend.settle();

    expect(currentAsideTurns(surface)).toEqual([{ q: "Why?", a: "Retaken." }]);
    expect(surface.busy).toBeFalse();
  });

  test("Esc then Thought toggle keeps a committed retake", async () => {
    const { source, state, surface } = surfaceWithTurns([{ q: "Why?", a: "Because." }]);
    surface.focus = "turns";
    let finish!: (value: unknown) => void;
    let aborted = false;
    const api = {
      ...source.api,
      retakeAside: async (
        _request: unknown,
        _onDelta: (text: string) => void,
        _callbacks: unknown,
        signal: AbortSignal
      ) => await new Promise<unknown>((resolve) => {
        finish = resolve;
        signal.addEventListener("abort", () => { aborted = true; }, { once: true });
      })
    } as unknown as StoryApi;
    const sourceWithApi = { ...source, api };
    const backend = new ActionRuntime(state, () => undefined);
    const key = (name: string) => ({
      name,
      sequence: name,
      shift: false,
      ctrl: false,
      meta: false
    }) as Parameters<typeof handleKey>[0];
    const press = (name: string) => handleKey(
      key(name),
      state,
      sourceWithApi,
      createWrapCache(),
      () => undefined,
      async () => undefined,
      () => undefined,
      null,
      () => undefined,
      () => undefined,
      backend
    );

    const retake = press("r");
    await Promise.resolve();
    expect(surface.busy).toBeTrue();
    await press("escape");
    expect(aborted).toBeTrue();
    await press("t");
    expect(surface.thoughtsVisible).toBeTrue();
    finish({
      schemaVersion: 2 as const,
      id: "s1",
      anchor: null,
      title: "why",
      turns: [{ q: "Why?", a: "Retaken after stop." }]
    });
    await retake;
    await backend.settle();

    expect(currentAsideTurns(surface)).toEqual([{ q: "Why?", a: "Retaken after stop." }]);
    expect(surface.busy).toBeFalse();
  });

  test("Esc then Thought toggle restores an uncommitted ask", async () => {
    const { source, state, surface } = surfaceWithTurns([]);
    surface.composer.text = "Why?";
    surface.composer.cursor = surface.composer.text.length;
    let finish!: (value: unknown) => void;
    let aborted = false;
    const api = {
      ...source.api,
      askAsideV2: async (
        _request: unknown,
        _onDelta: (text: string) => void,
        callbacks: {
          onReasoning?: (delta: { text: string; tokenCount: number }) => void;
        },
        signal: AbortSignal
      ) => {
        callbacks.onReasoning?.({ text: "thinking", tokenCount: 3 });
        return await new Promise<unknown>((resolve) => {
          finish = resolve;
          signal.addEventListener("abort", () => { aborted = true; }, { once: true });
        });
      }
    } as unknown as StoryApi;
    const sourceWithApi = { ...source, api };
    const backend = new ActionRuntime(state, () => undefined);
    const key = (name: string) => ({
      name,
      sequence: name,
      shift: false,
      ctrl: false,
      meta: false
    }) as Parameters<typeof handleKey>[0];
    const press = (name: string) => handleKey(
      key(name),
      state,
      sourceWithApi,
      createWrapCache(),
      () => undefined,
      async () => undefined,
      () => undefined,
      null,
      () => undefined,
      () => undefined,
      backend
    );

    const ask = press("return");
    await Promise.resolve();
    expect(surface.busy).toBeTrue();
    expect(surface.streamThoughts).toBe("thinking");
    await press("escape");
    expect(aborted).toBeTrue();
    await press("t");
    expect(surface.thoughtsVisible).toBeTrue();
    finish(null);
    await ask;
    await backend.settle();

    expect(surface.composer.text).toBe("Why?");
    expect(surface.busy).toBeFalse();
  });

  test("Esc aborts a v2 version preload before dispatching the ask", async () => {
    const { source, state, surface } = surfaceWithTurns([]);
    let startPreload!: () => void;
    let releasePreload!: () => void;
    let preloadSignal: AbortSignal | undefined;
    let askCalls = 0;
    const preloadStarted = new Promise<void>((resolve) => {
      startPreload = resolve;
    });
    const preload = new Promise<unknown>((resolve) => {
      releasePreload = () => resolve(source.payload);
    });
    const api = storyApiFromWorkerTransport({
      call: async (
        method: string,
        _input: unknown,
        options?: { signal?: AbortSignal }
      ) => {
        if (method === "loadStory") {
          preloadSignal = options?.signal;
          startPreload();
          preloadSignal?.addEventListener("abort", releasePreload, { once: true });
          return await preload;
        }
        if (method === "askAside") {
          askCalls += 1;
          throw new Error("askAside must not dispatch after abort");
        }
        throw new Error(`Unexpected worker method: ${method}`);
      }
    } as never);
    const sourceWithApi = { ...source, api };
    const backend = new ActionRuntime(state, () => undefined);
    const key = (name: string) => ({
      name,
      sequence: name,
      shift: false,
      ctrl: false,
      meta: false
    }) as Parameters<typeof handleKey>[0];

    const ask = sendAsideQuestion(state, api, "Why?");
    await preloadStarted;
    expect(surface.busy).toBeTrue();
    await handleKey(
      key("escape"),
      state,
      sourceWithApi,
      createWrapCache(),
      () => undefined,
      async () => undefined,
      () => undefined,
      null,
      () => undefined,
      () => undefined,
      backend
    );
    const settledBeforeFallback = await Promise.race([
      ask.then(() => true, () => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100))
    ]);
    if (!settledBeforeFallback) releasePreload();
    await ask;

    expect(settledBeforeFallback).toBeTrue();
    expect(preloadSignal?.aborted).toBeTrue();
    expect(askCalls).toBe(0);
    expect(surface.busy).toBeFalse();
    expect(state.abort).toBeNull();
  });

  test("a stalled v2 hop does not block later local input", async () => {
    const { source, state, surface } = surfaceWithTurns([
      { q: "First?", a: "One." },
      { q: "Second?", a: "Two." }
    ]);
    surface.focus = "turns";
    surface.turnCursor = 1;
    const first = { partId: "part-1", takeId: "take-1", sessionCount: 1 };
    const second = { partId: "part-2", takeId: "take-2", sessionCount: 1 };
    surface.anchor = first;
    surface.anchors = [first, second];
    surface.anchorIndex = 0;
    let release!: (value: unknown) => void;
    const api = {
      ...source.api,
      getAsideV2: async () => await new Promise<unknown>((resolve) => { release = resolve; })
    } as unknown as StoryApi;
    const sourceWithApi = { ...source, api };
    const backend = new ActionRuntime(state, () => undefined);
    const key = (name: string) => ({
      name,
      sequence: name,
      shift: false,
      ctrl: false,
      meta: false
    }) as Parameters<typeof handleKey>[0];
    const press = (name: string) => handleKey(
      key(name),
      state,
      sourceWithApi,
      createWrapCache(),
      () => undefined,
      async () => undefined,
      () => undefined,
      null,
      () => undefined,
      () => undefined,
      backend
    );

    const hop = press("]");
    const completed = await Promise.race([
      hop.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50))
    ]);
    expect(completed).toBeTrue();

    await press("up");
    expect(surface.turnCursor).toBe(0);
    release({
      schemaVersion: 2 as const,
      anchor: second,
      sessions: [{ id: "s2", title: "second", anchor: second, turns: [] }],
      anchors: [first, second]
    });
    await backend.settle();
    expect(surface.anchor).toEqual(first);
  });

  test("a stalled v2 delete still admits local focus input", async () => {
    const { source, state, surface } = surfaceWithTurns([
      { q: "First?", a: "One." },
      { q: "Second?", a: "Two." },
      { q: "Third?", a: "Three." }
    ]);
    surface.focus = "turns";
    surface.turnCursor = 2;
    let release!: () => void;
    const api = {
      ...source.api,
      deleteAsideTurn: async () => await new Promise<void>((resolve) => { release = resolve; })
    } as unknown as StoryApi;
    const sourceWithApi = { ...source, api };
    const backend = new ActionRuntime(state, () => undefined);
    const key = (name: string) => ({
      name,
      sequence: name,
      shift: false,
      ctrl: false,
      meta: false
    }) as Parameters<typeof handleKey>[0];
    const press = (name: string) => handleKey(
      key(name),
      state,
      sourceWithApi,
      createWrapCache(),
      () => undefined,
      async () => undefined,
      () => undefined,
      null,
      () => undefined,
      () => undefined,
      backend
    );

    await press("D");
    await press("D");
    const commit = press("up");
    const completed = await Promise.race([
      commit.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50))
    ]);
    expect(completed).toBeTrue();
    expect(surface.turnCursor).toBe(0);
    release();
    await backend.settle();
  });

  test("ignores a v2 hop result after the story changes", async () => {
    const { source, state, surface } = surfaceWithTurns([{ q: "Why?", a: "Because." }]);
    const first = { partId: "part-1", takeId: "take-1", sessionCount: 1 };
    const second = { partId: "part-2", takeId: "take-2", sessionCount: 1 };
    surface.anchor = first;
    surface.anchors = [first, second];
    surface.anchorIndex = 0;
    let release!: (value: unknown) => void;
    const api = {
      ...source.api,
      getAsideV2: async () => await new Promise<unknown>((resolve) => { release = resolve; })
    } as unknown as StoryApi;
    const backend = new ActionRuntime(state, () => undefined);
    await asideV2KeyAction(
      { action: "aside-anchor-next" },
      state,
      surface,
      { source: { api, config: state.config }, backend }
    );
    state.payload = { ...state.payload, id: "replacement-story" };
    release({
      schemaVersion: 2 as const,
      anchor: second,
      sessions: [{ id: "s2", title: "second", anchor: second, turns: [] }],
      anchors: [first, second]
    });
    await backend.settle();
    expect(surface.anchor).toEqual(first);
    expect(surface.sessions[0]?.id).toBe("s1");
  });

  test("retake callbacks and settlement keep ownership of the current surface", async () => {
    const { source, state, surface } = surfaceWithTurns([
      { q: "Why?", a: "Because." }
    ]);
    let emitDelta!: (text: string) => void;
    let emitReasoning!: (delta: { text: string; tokenCount: number }) => void;
    let finish!: (value: unknown) => void;
    const api = {
      ...source.api,
      retakeAside: async (
        _request: unknown,
        onDelta: (text: string) => void,
        callbacks: {
          onReasoning?: (delta: { text: string; tokenCount: number }) => void;
        },
        _signal: AbortSignal
      ) => {
        emitDelta = onDelta;
        emitReasoning = (delta) => callbacks.onReasoning?.(delta);
        return await new Promise<unknown>((resolve) => { finish = resolve; });
      }
    } as unknown as StoryApi;
    const backend = new ActionRuntime(state, () => undefined);
    const pending = asideV2KeyAction(
      { action: "aside-retake" },
      state,
      surface,
      { source: { api, config: state.config }, backend, repaint: () => undefined }
    );
    await Promise.resolve();
    emitDelta("before replacement");
    emitReasoning({ text: "private", tokenCount: 4 });
    const replacement = createAsideSurface(
      state.payload.id,
      state.payload.title,
      [{ id: "replacement", title: "new", anchor: null, turns: [{ q: "New?", a: "New." }] }],
      null,
      null,
      { v2: true }
    );
    state.aside = replacement;
    const notices = state.notices.entries.length;

    emitDelta("stale prose");
    emitReasoning({ text: "stale thought", tokenCount: 9 });
    finish({
      schemaVersion: 2 as const,
      id: "s1",
      anchor: null,
      title: "Why?",
      turns: [{ q: "Why?", a: "Retaken." }]
    });
    await pending;
    await backend.settle();

    expect(state.aside).toBe(replacement);
    expect(currentAsideTurns(replacement)).toEqual([{ q: "New?", a: "New." }]);
    expect(state.notices.entries).toHaveLength(notices);
    expect(surface.streamText).toBe("before replacement");
    expect(surface.streamThoughts).toBe("private");
    expect(surface.streamThoughtTokens).toBe(4);
  });

  test("fresh v2 turns keep the legacy adapter for Tab and Enter", () => {
    const { surface } = surfaceWithTurns([{ q: "Why?", a: "Because." }]);
    surface.focus = "composer";
    expect(asideNotes(surface)).toEqual([{ question: "Why?", answer: "Because." }]);
    expect(cycleAsideFocus(surface)).toBeTrue();
    expect(surface.focus).toBe("notes");
    expect(openAsideUseMenu(surface, asideCursor(surface))).toBeTrue();
  });

  test("legacy note reads follow the canonical session after a turn update", () => {
    const { surface } = surfaceWithTurns([{ q: "Why?", a: "Because." }]);
    surface.sessions[0] = {
      ...surface.sessions[0]!,
      turns: [{ q: "What now?", a: "Continue." }]
    };

    expect(asideNotes(surface)).toEqual([{ question: "What now?", answer: "Continue." }]);
    expect(currentAsideTurns(surface)[0]?.q).toBe("What now?");
  });

  test("matches the current anchor in the ordered hop projection", () => {
    const source = demoAppSource();
    const surface = createAsideSurface(
      source.payload.id,
      source.payload.title,
      [{ id: "s", title: "session", anchor: { partId: "p7", takeId: "t2" }, turns: [] }],
      null,
      null,
      {
        v2: true,
        anchor: { partId: "p7", takeId: "t2" },
        anchors: [
          { partId: "p12", takeId: "t1", partNumber: 12, sessionCount: 1 },
          { partId: "p7", takeId: "t2", partNumber: 7, sessionCount: 1 }
        ]
      }
    );
    expect(surface.anchorIndex).toBe(0);
    expect(asideHopStripText(surface.anchors, surface.anchor, 80)).toContain("[ ¶ 7");
  });

  test("g lands NAV focus on the selected anchor take", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const target = state.payload.path.at(-1)!;
    const anchor = { partId: target.id, takeId: target.id };
    const surface = createAsideSurface(
      state.payload.id,
      state.payload.title,
      [{ id: "s", title: "session", anchor, turns: [] }],
      null,
      null,
      {
        v2: true,
        anchor,
        anchors: [{ ...anchor, partNumber: 13, sessionCount: 1 }]
      }
    );
    if (!isAsideV2(surface)) throw new Error("expected an Aside session surface");
    state.aside = surface;
    state.mode = "ASIDE";
    state.focusIndex = 0;
    state.viewScroll = 17;
    state.viewScrollDelta = 2;
    const api = {
      ...source.api,
      switchLine: async () => state.payload
    } as StoryApi;
    const backend = new ActionRuntime(state, () => undefined);

    await asideV2KeyAction(
      { action: "aside-go-anchor" },
      state,
      surface,
      { source: { api, config: state.config }, backend, cache: createWrapCache<ProseStyle>() }
    );
    await backend.settle();

    const targetIndex = rowIndexForNode(createStoryViewModel(state.payload), target.id);
    expect(targetIndex).toBeGreaterThan(0);
    expect(state.focusIndex).toBe(targetIndex);
    expect(state.viewScroll).toBeNull();
    expect(state.viewScrollDelta).toBe(0);
    expect(state.mode).toBe("NAV");
    expect(state.aside).toBeNull();
  });

  test("session cycling preserves an explicit unanchored target", () => {
    const { surface } = surfaceWithTurns([]);
    surface.anchor = { partId: "part-1", takeId: "take-1" };
    surface.sessions = [
      { id: "anchored", title: "anchored", anchor: surface.anchor, turns: [] },
      { id: "unanchored", title: "legacy", anchor: null, turns: [] }
    ];
    surface.sessionIndex = 0;
    expect(cycleAsideSession(surface, 1)).toBeTrue();
    expect(surface.anchor).toBeNull();
  });

  test("shows delete toast in the turns footer", () => {
    const { state, surface } = surfaceWithTurns([{ q: "Why?", a: "Because." }]);
    state.toast = "▸ deleted 1 turn · u undoes";
    const text = frameText(renderAsideScreen(state, surface, 80, 24).lines);
    expect(text).toContain("▸ deleted 1 turn · u undoes");
  });

  test("busy v2 rendering has no composer box or duplicate caret", () => {
    const { state, surface } = surfaceWithTurns([{ q: "Why?", a: "Because." }]);
    surface.busy = true;
    surface.inflightQuestion = "What now?";
    surface.streamPhase = "thinking";
    const text = frameText(renderAsideScreen(state, surface, 80, 24).lines);
    expect(text).not.toContain("┏━ aside · prompt");
    expect(text).not.toContain("▯");
    expect((text.match(/▸/gu) ?? []).length).toBe(1);
    expect(text).not.toContain("the composer waits");
    expect((text.match(/⟳/gu) ?? []).length).toBe(1);
  });

  test("turn focus keeps the inactive composer free of a caret", () => {
    const { state, surface } = surfaceWithTurns([{ q: "Why?", a: "Because." }]);
    const text = frameText(renderAsideScreen(state, surface, 80, 24).lines);
    expect(text).toContain("Ask about this story");
    expect(text).not.toContain("▯");
  });

  test("up reveals an earlier focused turn in a scrollable history", async () => {
    const turns = Array.from({ length: 10 }, (_, index) => ({
      q: `Question ${index + 1}?`,
      a: `Answer ${index + 1} ${"word ".repeat(30)}`
    }));
    const { source, state, surface } = surfaceWithTurns(turns);
    const backend = new ActionRuntime(state, () => undefined);
    const key = (name: string) => ({
      name,
      sequence: name,
      shift: false,
      ctrl: false,
      meta: false
    }) as Parameters<typeof handleKey>[0];
    const renderer = { width: 80, height: 24 } as never;

    for (let index = 0; index < 7; index += 1) {
      await handleKey(
        key("up"),
        state,
        source,
        createWrapCache(),
        () => undefined,
        async () => undefined,
        () => undefined,
        renderer,
        () => undefined,
        () => undefined,
        backend
      );
    }

    expect(surface.turnCursor).toBe(2);
    const text = frameText(renderAsideScreen(state, surface, 80, 24).lines);
    expect(text).toContain("▸ You       Question 3?");
  });

  test("labels every narrow turn-focus key across two rows", () => {
    const { state, surface } = surfaceWithTurns([{ q: "Why?", a: "Because." }]);
    const text = frameText(renderAsideScreen(state, surface, 80, 24).lines);
    expect(text).toContain("↑↓ turn · ←→ session · n new · ↵ use · r retake · R reprompt · D delete");
    expect(text).toContain("t Thoughts · tab ask · [ ] hop · g go · esc exit");
  });

  test("composer keyline does not advertise hop keys", () => {
    const { state, surface } = surfaceWithTurns([{ q: "Why?", a: "Because." }]);
    surface.focus = "composer";
    const text = frameText(renderAsideScreen(state, surface, 80, 24).lines);
    expect(text).not.toContain("[ ] hop");
    expect(text).not.toContain("g go");
  });

  test("reset status owns exact counts and confirmation keys", () => {
    const { state, surface } = surfaceWithTurns([
      { q: "Why?", a: "Because." },
      { q: "Then?", a: "After." }
    ]);
    surface.turnCursor = 0;
    surface.confirmReset = { turnIndex: 0 };
    const text = frameText(renderAsideScreen(state, surface, 120, 36).lines);
    expect(text).toContain(" RESET  everything after this answer dies · 1 turns · 2 words");
    expect(text).toContain("⌫ confirms · esc keeps");
  });
});
