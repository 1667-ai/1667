import { expect, test } from "bun:test";
import { initialState } from "../src/app.js";
import { createAsideSurface } from "../src/aside-surface.js";
import { demoAppSource } from "../src/demo.js";
import { moveComposerTo, setComposerText } from "../src/composer-model.js";
import { handleOverlayAction } from "../src/overlay-actions.js";
import { ActionRuntime } from "../src/action-runtime.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { plainLine } from "../src/screens/story/frame.js";

function overlayContext(state: ReturnType<typeof initialState>, width: number, height: number) {
  return {
    backend: new ActionRuntime(state, () => undefined),
    cache: createWrapCache<ProseStyle>(),
    repaint: () => undefined,
    renderer: { width, height } as never,
    applyTheme: () => undefined,
    previewTheme: () => undefined
  };
}

test("long Aside titles keep the full-screen composer and footer visible", () => {
  for (const [width, height] of [[24, 16], [80, 24]] as const) {
    const source = demoAppSource();
    const state = initialState(source, false);
    state.mode = "ASIDE";
    state.aside = createAsideSurface(
      state.payload.id,
      "Long title ".repeat(500)
    );
    setComposerText(state.aside.composer, "Why?");
    moveComposerTo(state.aside.composer, 0);

    const frame = renderStoryScreen(state, { width, height });
    const lines = frame.lines.map(plainLine);
    const text = lines.join("\n");

    expect(lines).toHaveLength(height);
    expect(lines[0]).toContain("ASIDE ·");
    expect(text).toContain("aside · prompt");
    expect(text).toContain("Why?");
    expect(text).toContain("Esc write");
    expect(text).toContain("/clear");
    expect(lines.some((line) => line.includes("┗━"))).toBeTrue();
    expect(frame.lines.flat().some((part) => part.composerStart === 0
      && part.background === "compose accent")).toBeTrue();
    expect(frame.derived.composerSelectionProjection?.some((cell) => cell?.start === 0
      && cell.end === 1)).toBeTrue();
  }
});

test("idle Aside keeps exit and Clear visible at standard width", () => {
  const source = demoAppSource();
  const state = initialState(source, false);
  state.mode = "ASIDE";
  state.aside = createAsideSurface(state.payload.id, state.payload.title);

  const text = renderStoryScreen(state, { width: 80, height: 24 }).lines
    .map(plainLine)
    .join("\n");

  expect(text).toContain("Esc write");
  expect(text).toContain("/clear clear");
});

test("shows a submitted Aside question before the first provider delta", () => {
  const source = demoAppSource();
  const state = initialState(source, false);
  state.mode = "ASIDE";
  state.aside = createAsideSurface(state.payload.id, state.payload.title);
  state.aside.busy = true;
  state.aside.inflightQuestion = "What changes next?";

  const text = renderStoryScreen(state, { width: 80, height: 16 }).lines
    .map(plainLine)
    .join("\n");

  expect(text).toContain("Q: What changes next?");
  expect(text).toContain("A:");
  expect(text).not.toContain("(no Side Notes yet)");
});

test("streaming-to-saved Side Note keeps one left edge and wrap width", () => {
  const source = demoAppSource();
  const state = initialState(source, false);
  state.mode = "ASIDE";
  // Long enough to soft-wrap at 40 columns under a five-cell "  Q: "/"  A: " pad.
  const question = "Why does the wrap edge stay fixed when the answer lands?";
  const answer = "The answer keeps the same five-cell prefix so soft wraps do not jump when the stream becomes a saved Side Note.";
  const surface = createAsideSurface(state.payload.id, state.payload.title);
  state.aside = surface;
  surface.busy = true;
  surface.inflightQuestion = question;
  surface.streamText = answer;
  const width = 40;
  const height = 24;
  const streamingLines = renderStoryScreen(state, { width, height }).lines.map(plainLine);

  surface.busy = false;
  surface.inflightQuestion = null;
  surface.streamText = "";
  surface.notes = [{ question, answer }];
  surface.noteCursor = 0;
  surface.focus = "notes";
  const savedLines = renderStoryScreen(state, { width, height }).lines.map(plainLine);

  const contentLines = (lines: string[]) => lines.filter((line) =>
    line.includes("Q:") || line.includes("A:") || /^\s+\S/.test(line)
  );
  const streamContent = contentLines(streamingLines);
  const savedContent = contentLines(savedLines);
  // Same soft-wrap geometry: each content row's text after the pad matches.
  expect(streamContent.length).toBeGreaterThan(1);
  expect(savedContent.length).toBe(streamContent.length);
  for (let index = 0; index < streamContent.length; index += 1) {
    const stream = streamContent[index]!;
    const saved = savedContent[index]!;
    // Focus marker may replace the first pad cell on the first saved row.
    const streamBody = stream.replace(/^▸/, " ").trimEnd();
    const savedBody = saved.replace(/^▸/, " ").trimEnd();
    expect(savedBody).toBe(streamBody);
  }
});

test("Aside arrow motion follows the painted fullscreen soft-wrap", async () => {
  const source = demoAppSource();
  const state = initialState(source, false);
  state.mode = "ASIDE";
  state.aside = createAsideSurface(state.payload.id, state.payload.title);
  setComposerText(state.aside.composer, "x".repeat(77));
  moveComposerTo(state.aside.composer, 0);
  const context = overlayContext(state, 80, 24);

  await handleOverlayAction(
    { action: "cursor-down" },
    state,
    source,
    context
  );

  expect(state.aside.composer.cursor).toBe(76);
  expect(renderStoryScreen(state, { width: 80, height: 24 }).lines.flat()
    .some((part) => part.background === "compose accent" && part.composerStart === 76))
    .toBeTrue();
});

test("busy Aside footer advertises stop instead of send or write", () => {
  const source = demoAppSource();
  const state = initialState(source, false);
  state.mode = "ASIDE";
  state.aside = createAsideSurface(state.payload.id, state.payload.title);
  state.aside.busy = true;
  state.aside.inflightQuestion = "What changes next?";

  const text = renderStoryScreen(state, { width: 80, height: 16 }).lines
    .map(plainLine)
    .join("\n");

  expect(text).toContain("Esc stop");
  expect(text).not.toContain("Enter send");
  expect(text).not.toContain("Esc write");
});

test("offline Aside keeps the standard banner and fixed screen height", () => {
  for (const [width, height] of [[24, 12], [80, 16]] as const) {
    const source = demoAppSource();
    const state = initialState(source, false);
    state.mode = "ASIDE";
    state.aside = createAsideSurface(state.payload.id, state.payload.title);
    state.connection = {
      ...state.connection,
      down: true,
      attempt: 1,
      nextRetryAt: null,
      error: "offline"
    };

    const frame = renderStoryScreen(state, { width, height });
    const lines = frame.lines.map(plainLine);
    const text = lines.join("\n");

    expect(lines).toHaveLength(height);
    expect(lines[0]).toContain("connection lost");
    expect(text).toContain("aside · prompt");
    expect(text).toContain("Ask about this");
  }
});
