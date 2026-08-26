import { describe, expect, test } from "bun:test";
import { demoAppSource } from "../src/demo.js";
import { dispatch, initialState } from "../src/app.js";
import {
  asideBodyHeight,
  asideComposerRows,
  asideHistoryLayout,
  sendAsideQuestion
} from "../src/aside-actions.js";
import {
  createAsideSurface,
  isAsideV2,
  type AsideSessionSurfaceState
} from "../src/aside-surface.js";
import { handleOverlayAction } from "../src/overlay-actions.js";
import { ActionRuntime, beginInteraction } from "../src/action-runtime.js";
import type { StoryApi } from "../src/api.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";
import { setComposerText } from "../src/composer-model.js";
import { pasteInto } from "../src/keys.js";
import { renderAsideScreen } from "../src/screens/story/aside-screen.js";
import { frameText, plainLine, visibleWidth } from "../src/screens/story/frame.js";

function v2Surface(
  state: ReturnType<typeof initialState>,
  question: string,
  answer: string
): AsideSessionSurfaceState {
  const surface = createAsideSurface(
    state.payload.id,
    state.payload.title,
    [{
      id: "session-1",
      title: "long turn",
      anchor: null,
      turns: [{ q: question, a: answer }]
    }],
    null,
    null,
    { v2: true }
  );
  if (!isAsideV2(surface)) throw new Error("expected a v2 Aside surface");
  state.aside = surface;
  state.mode = "ASIDE";
  return surface;
}

function overlayContext(
  state: ReturnType<typeof initialState>,
  width: number,
  height: number
) {
  return {
    backend: new ActionRuntime(state, () => undefined),
    cache: createWrapCache<ProseStyle>(),
    repaint: () => undefined,
    renderer: { width, height } as never,
    applyTheme: () => undefined,
    previewTheme: () => undefined
  };
}

function dispatchAsideAction(
  action: Parameters<typeof dispatch>[0],
  state: ReturnType<typeof initialState>,
  source: ReturnType<typeof demoAppSource>,
  context: ReturnType<typeof overlayContext>
): Promise<void> {
  return dispatch(
    action,
    state,
    source,
    context.cache,
    context.repaint,
    async () => undefined,
    () => undefined,
    context.renderer,
    context.applyTheme,
    context.previewTheme,
    context.backend
  );
}

describe("Aside readability and navigation", () => {
  test("keeps a question treatment on every wrapped question row", () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const question = "question-marker ".repeat(40).trim();
    const answer = "answer-marker ".repeat(24).trim();
    const surface = v2Surface(state, question, answer);
    const frame = renderAsideScreen(state, surface, 32, 80);
    const questionRows = frame.lines.filter((line) => plainLine(line).includes("question-marker"));
    const answerRows = frame.lines.filter((line) => plainLine(line).includes("answer-marker"));

    expect(questionRows.length).toBeGreaterThan(1);
    expect(answerRows.length).toBeGreaterThan(1);
    expect(questionRows.every((line) => plainLine(line).includes("›"))).toBeTrue();
    expect(questionRows.every((line) => line.some((part) =>
      part.role === "accent · deep" || part.role === "focus / accent"
    ))).toBeTrue();
    expect(answerRows.every((line) => line.every((part) =>
      part.role !== "accent · deep" && part.role !== "focus / accent"
    ))).toBeTrue();
    expect(frame.lines.every((line) => visibleWidth(plainLine(line)) <= 32)).toBeTrue();
  });

  test("fully highlights every wrapped row of the selected question", () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const question = "selected-question ".repeat(40).trim();
    const surface = v2Surface(state, question, "answer");
    const frame = renderAsideScreen(state, surface, 32, 80);
    const questionRows = frame.lines.filter((line) =>
      plainLine(line).includes("selected-question")
    );

    const continuationRows = questionRows.slice(1);
    expect(continuationRows.length).toBeGreaterThan(0);
    expect(continuationRows.every((line) => line.some((part) =>
      part.text.includes("selected-question") && part.role === "prose"
    ))).toBeTrue();
  });

  test("labels the turns exit action as esc exit", () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const surface = v2Surface(state, "Why?", "Because.");
    const turnsText = frameText(renderAsideScreen(state, surface, 120, 24).lines);
    expect(turnsText).toContain("esc exit");
    expect(turnsText).not.toContain("esc read");

    surface.focus = "composer";
    const composerText = frameText(renderAsideScreen(state, surface, 120, 24).lines);
    expect(composerText).toContain("esc exit");
    expect(composerText).not.toContain("esc read");
  });

  test("scrolls a long turn from the tail to the start at small and large sizes", async () => {
    const question = "question-start " + "question-word ".repeat(160) + "question-end";
    const answer = "answer-start " + "answer-word ".repeat(600) + "answer-end";
    for (const [width, height] of [[24, 10], [120, 36]] as const) {
      const source = demoAppSource();
      const state = initialState(source, false);
      const surface = v2Surface(state, question, answer);
      const context = overlayContext(state, width, height);

      const renderText = () => frameText(renderAsideScreen(state, surface, width, height).lines);
      const tail = renderText();
      expect(tail).toContain("answer-end");

      await handleOverlayAction({ action: "scroll-line-up" }, state, source, context);
      expect(surface.scrollTop).not.toBeNull();
      expect(renderText()).not.toBe(tail);

      for (let page = 0; page < 300; page += 1) {
        await handleOverlayAction({ action: "scroll-up" }, state, source, context);
      }
      const start = renderText();
      expect(start).toContain("question-start");

      await handleOverlayAction({ action: "scroll-line-down" }, state, source, context);
      expect(surface.scrollTop).not.toBe(0);
      for (let page = 0; page < 300; page += 1) {
        await handleOverlayAction({ action: "scroll-down" }, state, source, context);
      }
      expect(surface.scrollTop).toBeNull();
      expect(renderText()).toContain("answer-end");
    }
  });

  test("line, page, and wheel scrolling keep the selected turn stable", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const question = "question-start " + "question-word ".repeat(80) + "question-end";
    const answer = "answer-start " + "answer-word ".repeat(480) + "answer-end";
    const surface = v2Surface(state, question, answer);
    const session = surface.sessions[surface.sessionIndex]!;
    surface.sessions[surface.sessionIndex] = {
      ...session,
      turns: [{ q: "earlier question", a: "earlier answer" }, ...session.turns]
    };
    surface.turnCursor = 1;
    const context = overlayContext(state, 80, 24);
    const selectedTurn = surface.turnCursor;
    const page = asideBodyHeight(surface, 80, 24, asideComposerRows(24));

    await handleOverlayAction({ action: "scroll-line-up" }, state, source, context);
    const first = surface.scrollTop;
    expect(first).not.toBeNull();
    await handleOverlayAction({ action: "scroll-line-up" }, state, source, context);
    expect(surface.scrollTop).toBe(first! - 1);
    expect(surface.turnCursor).toBe(selectedTurn);

    for (let step = 0; step < 20; step += 1) {
      await handleOverlayAction({ action: "scroll-line-up" }, state, source, context);
    }
    const middle = surface.scrollTop!;
    await handleOverlayAction({ action: "scroll-down" }, state, source, context);
    expect(surface.scrollTop).toBe(middle + page);
    expect(surface.turnCursor).toBe(selectedTurn);

    await handleOverlayAction({ action: "scroll-line-down" }, state, source, context);
    expect(surface.scrollTop).toBe(middle + page + 1);
    expect(surface.turnCursor).toBe(selectedTurn);
  });

  test("Up then Down reveals the selected question from its start", async () => {
    const targetIndex = 6;
    const turns = [
      ...Array.from({ length: targetIndex }, (_, index) => ({
        q: `short question ${index}`,
        a: `short answer ${index}`
      })),
      {
        q: "long-question-start " + "question-word ".repeat(160) + "long-question-end",
        a: "long-answer-start " + "answer-word ".repeat(600) + "long-answer-end"
      }
    ];

    for (const [width, height] of [[24, 8], [120, 36]] as const) {
      const source = demoAppSource();
      const state = initialState(source, false);
      const surface = v2Surface(state, turns[targetIndex]!.q, turns[targetIndex]!.a);
      const session = surface.sessions[surface.sessionIndex]!;
      surface.sessions[surface.sessionIndex] = { ...session, turns };
      surface.focus = "turns";
      surface.turnCursor = targetIndex;
      surface.scrollTop = null;
      const context = overlayContext(state, width, height);

      for (let index = targetIndex; index > 0; index -= 1) {
        await handleOverlayAction({ action: "focus-previous" }, state, source, context);
      }
      for (let index = 0; index < targetIndex; index += 1) {
        await handleOverlayAction({ action: "focus-next" }, state, source, context);
      }

      const layout = asideHistoryLayout(surface, width);
      const bodyRows = asideBodyHeight(surface, width, height, asideComposerRows(height));
      const max = Math.max(0, layout.body.length - bodyRows);
      expect(surface.turnCursor).toBe(targetIndex);
      expect(surface.scrollTop ?? max).toBe(layout.turnStarts[targetIndex]);
      const text = frameText(renderAsideScreen(state, surface, width, height).lines);
      expect(text).toContain("long-question-start");
      if (height > 8) expect(text).toContain("long-answer-start");
    }
  });

  test("busy v2 scrolling remains visible and survives settlement", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const question = "saved-question " + "saved-word ".repeat(80);
    const answer = "saved-answer " + "saved-word ".repeat(480);
    const surface = v2Surface(state, question, answer);
    const savedSession = surface.sessions[surface.sessionIndex]!;
    surface.sessions[surface.sessionIndex] = {
      ...savedSession,
      turns: [{ q: "earlier question", a: "earlier answer" }, ...savedSession.turns]
    };
    surface.turnCursor = 1;
    let emit!: (text: string) => void;
    let release!: (value: unknown) => void;
    const pending = new Promise<unknown>((resolve) => { release = resolve; });
    const api = {
      ...source.api,
      askAsideV2: async (
        _request: unknown,
        onDelta: (text: string) => void,
        _callbacks: unknown,
        _signal: AbortSignal
      ) => {
        emit = onDelta;
        return await pending;
      }
    } as unknown as StoryApi;
    const context = overlayContext(state, 80, 24);
    const ask = sendAsideQuestion(state, api, "streamed question", {
      cache: createWrapCache(),
      repaint: () => undefined
    });
    await Promise.resolve();
    expect(surface.busy).toBeTrue();
    const selectedTurn = surface.turnCursor;

    await handleOverlayAction({ action: "scroll-line-up" }, state, source, context);
    const selectedTop = surface.scrollTop;
    expect(selectedTop).not.toBeNull();
    expect(surface.turnCursor).toBe(selectedTurn);
    await handleOverlayAction({ action: "scroll-line-up" }, state, source, context);
    expect(surface.scrollTop).toBe(selectedTop! - 1);

    emit("stream-tail " + "stream-word ".repeat(200));
    expect(surface.scrollTop).toBe(selectedTop! - 1);
    const session = surface.sessions[surface.sessionIndex]!;
    release({
      schemaVersion: 2,
      id: session.id,
      anchor: session.anchor,
      title: session.title,
      turns: [...session.turns, { q: "streamed question", a: "stream answer" }],
      payload: state.payload
    });
    await ask;
    expect(surface.busy).toBeFalse();
    expect(surface.scrollTop).toBe(selectedTop! - 1);
  });

  test("busy scroll then API failure restores the submitted question", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const surface = v2Surface(
      state,
      "saved-question " + "saved-word ".repeat(80),
      "saved-answer " + "saved-word ".repeat(480)
    );
    surface.focus = "composer";
    setComposerText(surface.composer, "failed question");
    let rejectAsk!: (error: unknown) => void;
    const pending = new Promise<never>((_resolve, reject) => { rejectAsk = reject; });
    source.api = {
      ...source.api,
      askAsideV2: async (
        _request: unknown,
        _onDelta: (text: string) => void,
        _callbacks: unknown,
        _signal: AbortSignal
      ) => await pending
    } as unknown as StoryApi;
    const context = overlayContext(state, 80, 24);

    await dispatchAsideAction({ action: "send" }, state, source, context);
    await Promise.resolve();
    await dispatchAsideAction({ action: "scroll-line-up" }, state, source, context);
    const selectedTop = surface.scrollTop;
    rejectAsk(new Error("provider failed"));
    await context.backend.whenIdle();

    expect(surface.composer.text).toBe("failed question");
    expect(surface.scrollTop).toBe(selectedTop);
  });

  test("busy scroll then Stop restores the submitted question", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const surface = v2Surface(
      state,
      "saved-question " + "saved-word ".repeat(80),
      "saved-answer " + "saved-word ".repeat(480)
    );
    surface.focus = "composer";
    setComposerText(surface.composer, "stopped question");
    let requestSignal!: AbortSignal;
    source.api = {
      ...source.api,
      askAsideV2: async (
        _request: unknown,
        _onDelta: (text: string) => void,
        _callbacks: unknown,
        signal: AbortSignal
      ) => {
        requestSignal = signal;
        return await new Promise<null>((resolve) => {
          signal.addEventListener("abort", () => resolve(null), { once: true });
        });
      }
    } as unknown as StoryApi;
    const context = overlayContext(state, 80, 24);

    await dispatchAsideAction({ action: "send" }, state, source, context);
    await Promise.resolve();
    await dispatchAsideAction({ action: "scroll-line-up" }, state, source, context);
    const selectedTop = surface.scrollTop;
    await dispatchAsideAction({ action: "cancel" }, state, source, context);
    expect(requestSignal.aborted).toBeTrue();
    await context.backend.whenIdle();

    expect(surface.composer.text).toBe("stopped question");
    expect(surface.scrollTop).toBe(selectedTop);
  });

  test("newer draft survives API failure after a busy scroll", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const surface = v2Surface(
      state,
      "saved-question " + "saved-word ".repeat(80),
      "saved-answer " + "saved-word ".repeat(480)
    );
    surface.focus = "composer";
    setComposerText(surface.composer, "failed question");
    let rejectAsk!: (error: unknown) => void;
    const pending = new Promise<never>((_resolve, reject) => { rejectAsk = reject; });
    source.api = {
      ...source.api,
      askAsideV2: async (
        _request: unknown,
        _onDelta: (text: string) => void,
        _callbacks: unknown,
        _signal: AbortSignal
      ) => await pending
    } as unknown as StoryApi;
    const context = overlayContext(state, 80, 24);

    await dispatchAsideAction({ action: "send" }, state, source, context);
    await Promise.resolve();
    expect(surface.busy).toBeTrue();
    expect(pasteInto(state, "newer draft")).toBeTrue();
    beginInteraction(state);
    await dispatchAsideAction({ action: "scroll-line-up" }, state, source, context);
    const selectedTop = surface.scrollTop;
    expect(selectedTop).not.toBeNull();

    rejectAsk(new Error("provider failed"));
    await context.backend.whenIdle();
    expect(surface.busy).toBeFalse();
    expect(surface.composer.text).toBe("newer draft");
    expect(surface.scrollTop).toBe(selectedTop);
  });

  test("newer draft survives Stop after a busy scroll", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const surface = v2Surface(
      state,
      "saved-question " + "saved-word ".repeat(80),
      "saved-answer " + "saved-word ".repeat(480)
    );
    surface.focus = "composer";
    setComposerText(surface.composer, "stopped question");
    let requestSignal!: AbortSignal;
    source.api = {
      ...source.api,
      askAsideV2: async (
        _request: unknown,
        _onDelta: (text: string) => void,
        _callbacks: unknown,
        signal: AbortSignal
      ) => {
        requestSignal = signal;
        return await new Promise<null>((resolve) => {
          signal.addEventListener("abort", () => resolve(null), { once: true });
        });
      }
    } as unknown as StoryApi;
    const context = overlayContext(state, 80, 24);

    await dispatchAsideAction({ action: "send" }, state, source, context);
    await Promise.resolve();
    expect(surface.busy).toBeTrue();
    expect(pasteInto(state, "newer draft")).toBeTrue();
    beginInteraction(state);
    await dispatchAsideAction({ action: "scroll-line-up" }, state, source, context);
    const selectedTop = surface.scrollTop;
    expect(selectedTop).not.toBeNull();

    await dispatchAsideAction({ action: "cancel" }, state, source, context);
    expect(requestSignal.aborted).toBeTrue();
    await context.backend.whenIdle();
    expect(surface.busy).toBeFalse();
    expect(surface.composer.text).toBe("newer draft");
    expect(surface.scrollTop).toBe(selectedTop);
  });
});
