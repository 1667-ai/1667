import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { CliRenderEvents, TextRenderable, type CliRenderer } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { initialState } from "../src/app.js";
import { createComposer } from "../src/composer-model.js";
import { demoAppSource } from "../src/demo.js";
import { createInteractiveFrameRuntime } from "../src/interactive-frame-runtime.js";
import { createPalette } from "../src/palette.js";
import { createPresentedInputQueue, type PresentedInputQueue } from "../src/presented-input-queue.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { plainLine } from "../src/screens/story/frame.js";
import { deriveStoryFrameLayout } from "../src/story-frame-layout.js";
import { initialSettingsOverlay } from "../src/settings-overlay-model.js";
import { storyFrameWrapPlans } from "../src/story-wrap-build.js";
import { createStorySurface, type StorySurface } from "../src/story-surface.js";
import { scrollStoryViewport } from "../src/viewport-intent.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";
import { syntheticStoryPayload } from "./fixtures/story.js";

function createControlledRenderer(width: number, height: number): {
  renderer: CliRenderer;
  resize(width: number, height: number): void;
  present(frameId: number): void;
  fail(frameId: number): void;
  renderRequests(): number;
} {
  const events = new EventEmitter();
  const idleResolvers: Array<() => void> = [];
  let renderRequests = 0;
  const controlled = {
    width,
    height,
    frameId: 0,
    requestRender() { renderRequests += 1; },
    clearSelection() {},
    idle() {
      return new Promise<void>((resolve) => { idleResolvers.push(resolve); });
    },
    on: events.on.bind(events),
    off: events.off.bind(events)
  };
  return {
    renderer: controlled as unknown as CliRenderer,
    resize(nextWidth, nextHeight) {
      controlled.width = nextWidth;
      controlled.height = nextHeight;
    },
    present(frameId) {
      controlled.frameId = frameId;
      events.emit(CliRenderEvents.FRAME, { frameId });
    },
    fail(frameId) {
      controlled.frameId = frameId;
      idleResolvers.shift()?.();
    },
    renderRequests: () => renderRequests
  };
}

async function drainMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

describe("interactive frame runtime", () => {
  test("atomically paints a warm frame and exposes bounded phase statistics", async () => {
    const setup = await createTestRenderer({ width: 120, height: 36 });
    const state = initialState(demoAppSource(false), false);
    const wrapCache = createWrapCache<ProseStyle>();
    renderStoryScreen(state, { width: 120, height: 36, wrapCache });
    const painted: Parameters<StorySurface["paint"]>[0][] = [];
    const surface: StorySurface = {
      paint(frame) { painted.push(frame); },
      setPageSelectable() {},
      setBackground() {},
      onMouse() {}
    };
    const built: number[] = [];
    const runtime = createInteractiveFrameRuntime({
      state,
      renderer: setup.renderer,
      surface,
      palette: () => createPalette("lantern", "256"),
      wrapCache,
      onBuilt: (version) => built.push(version),
      onError: (error) => { throw error; },
      profile: true
    });

    runtime.invalidate();
    runtime.flush();

    expect(painted).toHaveLength(1);
    expect(state.hitRows).toHaveLength(36);
    expect(built).toEqual([1]);
    const report = runtime.profile(null)!;
    expect(report.scheduler).toMatchObject({
      invalidations: 1,
      frames: 1
    });
    expect(report.application).toMatchObject({
      committedFrames: 1,
      loadingFrames: 0
    });
    expect(report.application.total.samples).toBe(1);

    runtime.dispose();
    setup.renderer.destroy();
  });

  test("paints wide inline Settings through one native selection buffer", async () => {
    const setup = await createTestRenderer({ width: 160, height: 36 });
    const source = demoAppSource(false);
    const state = initialState(source, false);
    state.mode = "SETTINGS";
    state.settings = initialSettingsOverlay(source.settingsView, state.config);
    state.settings.edit = {
      row: "model",
      mode: "text",
      composer: createComposer("draft-model"),
      initial: ""
    };
    const wrapCache = createWrapCache<ProseStyle>();
    renderStoryScreen(state, { width: 160, height: 36, wrapCache });
    const paintOptions: Parameters<StorySurface["paint"]>[4][] = [];
    const surface: StorySurface = {
      paint(_frame, _palette, _layout, _selectable, options) {
        paintOptions.push(options);
      },
      setPageSelectable() {},
      setBackground() {},
      onMouse() {}
    };
    const runtime = createInteractiveFrameRuntime({
      state,
      renderer: setup.renderer,
      surface,
      palette: () => createPalette("lantern", "256"),
      wrapCache,
      onBuilt: () => undefined,
      onError: (error) => { throw error; }
    });

    runtime.invalidate();
    runtime.flush();

    expect(paintOptions.at(-1)).toEqual({ singleSelectionBuffer: true });
    runtime.dispose();
    setup.renderer.destroy();
  });

  test("an older native frame cannot consume a newer app commit", () => {
    const controlled = createControlledRenderer(120, 36);
    const state = initialState(demoAppSource(false), false);
    const wrapCache = createWrapCache<ProseStyle>();
    renderStoryScreen(state, { width: 120, height: 36, wrapCache });
    const surface: StorySurface = {
      paint() {},
      setPageSelectable() {},
      setBackground() {},
      onMouse() {}
    };
    const presented: number[] = [];
    const runtime = createInteractiveFrameRuntime({
      state,
      renderer: controlled.renderer,
      surface,
      palette: () => createPalette("lantern", "256"),
      wrapCache,
      onBuilt() {},
      onPresented: (frameToken) => presented.push(frameToken),
      onError: (error) => { throw error; },
      profile: true
    });

    runtime.invalidate();
    state.toast = "newer app commit";
    runtime.invalidate();
    runtime.flush();
    const latestFrameToken = runtime.frameToken;

    controlled.present(0);
    expect(presented).toEqual([]);
    expect(runtime.profile(null)!.application.presentation.samples).toBe(0);

    controlled.present(1);
    expect(presented).toEqual([latestFrameToken]);
    expect(runtime.profile(null)!.application.presentation.samples).toBe(1);

    runtime.dispose();
  });

  test("retries one native failure and presents the exact application token", async () => {
    const controlled = createControlledRenderer(120, 36);
    const state = initialState(demoAppSource(false), false);
    const wrapCache = createWrapCache<ProseStyle>();
    renderStoryScreen(state, { width: 120, height: 36, wrapCache });
    const surface: StorySurface = {
      paint() {},
      setPageSelectable() {},
      setBackground() {},
      onMouse() {}
    };
    const presented: number[] = [];
    const runtime = createInteractiveFrameRuntime({
      state,
      renderer: controlled.renderer,
      surface,
      palette: () => createPalette("lantern", "256"),
      wrapCache,
      onBuilt() {},
      onPresented: (frameToken) => presented.push(frameToken),
      onError: (error) => { throw error; },
      profile: true
    });

    runtime.invalidate();
    expect(controlled.renderRequests()).toBe(1);
    controlled.fail(1);
    await drainMicrotasks();
    expect(controlled.renderRequests()).toBe(2);
    expect(runtime.failed).toBeFalse();

    controlled.present(2);
    expect(presented).toEqual([runtime.frameToken]);
    expect(runtime.failed).toBeFalse();
    expect(controlled.renderRequests()).toBe(2);
    expect(runtime.profile(null)!.application.presentation.samples).toBe(1);

    runtime.dispose();
  });

  test("persistent native failure drops unsafe input and invokes queued Ctrl+C escape", async () => {
    const controlled = createControlledRenderer(120, 36);
    const state = initialState(demoAppSource(false), false);
    const wrapCache = createWrapCache<ProseStyle>();
    renderStoryScreen(state, { width: 120, height: 36, wrapCache });
    const surface: StorySurface = {
      paint() {},
      setPageSelectable() {},
      setBackground() {},
      onMouse() {}
    };
    let runtime!: ReturnType<typeof createInteractiveFrameRuntime>;
    let handled = 0;
    let quitRequests = 0;
    const errors: unknown[] = [];
    const inputs = createPresentedInputQueue({
      flush: () => runtime.flush(),
      ready: () => false
    });
    runtime = createInteractiveFrameRuntime({
      state,
      renderer: controlled.renderer,
      surface,
      palette: () => createPalette("lantern", "256"),
      wrapCache,
      onBuilt() {},
      onPresentationFailure: inputs.presentationFailed,
      onError: (error) => errors.push(error)
    });

    runtime.invalidate();
    inputs.enqueue(() => { handled += 1; });
    inputs.enqueue(() => { handled += 1; }, () => { quitRequests += 1; });
    controlled.fail(1);
    await drainMicrotasks();
    expect(controlled.renderRequests()).toBe(2);
    expect(runtime.failed).toBeFalse();
    expect(inputs.pending).toBe(2);

    controlled.fail(2);
    await drainMicrotasks();
    expect(runtime.failed).toBeTrue();
    expect(errors).toHaveLength(1);
    expect(handled).toBe(0);
    expect(quitRequests).toBe(1);
    expect(inputs.pending).toBe(0);
    expect(inputs.shouldQuitImmediately("EDITOR", runtime.failed)).toBeTrue();

    runtime.invalidate();
    expect(controlled.renderRequests()).toBe(2);
    runtime.flush();
    expect(controlled.renderRequests()).toBe(3);
    expect(runtime.failed).toBeTrue();

    runtime.invalidate();
    runtime.flush();
    expect(controlled.renderRequests()).toBe(3);
    expect(runtime.failed).toBeTrue();

    controlled.present(3);
    expect(runtime.failed).toBeFalse();
    runtime.flush();
    expect(controlled.renderRequests()).toBe(4);

    runtime.dispose();
  });

  test("does not reopen an exhausted input-owned presentation recovery", async () => {
    const controlled = createControlledRenderer(120, 36);
    const state = initialState(demoAppSource(false), false);
    const wrapCache = createWrapCache<ProseStyle>();
    renderStoryScreen(state, { width: 120, height: 36, wrapCache });
    const surface: StorySurface = {
      paint() {},
      setPageSelectable() {},
      setBackground() {},
      onMouse() {}
    };
    const errors: unknown[] = [];
    let runtime!: ReturnType<typeof createInteractiveFrameRuntime>;
    let handled = 0;
    let dropped = 0;
    const inputs = createPresentedInputQueue({
      flush: () => runtime.flush(),
      ready: () => false,
      recoveryExhausted: () => runtime.inputRecoveryExhausted
    });
    runtime = createInteractiveFrameRuntime({
      state,
      renderer: controlled.renderer,
      surface,
      palette: () => createPalette("lantern", "256"),
      wrapCache,
      onBuilt() {},
      onPresentationFailure: inputs.presentationFailed,
      onError: (error) => errors.push(error)
    });

    runtime.invalidate();
    controlled.fail(1);
    await drainMicrotasks();
    controlled.fail(2);
    await drainMicrotasks();
    expect(runtime.failed).toBeTrue();
    expect(runtime.inputRecoveryExhausted).toBeFalse();

    inputs.enqueue(() => { handled += 1; }, () => { dropped += 1; });
    expect(controlled.renderRequests()).toBe(3);
    controlled.fail(3);
    await drainMicrotasks();
    controlled.fail(4);
    await drainMicrotasks();
    expect(runtime.failed).toBeTrue();
    expect(runtime.inputRecoveryExhausted).toBeTrue();
    expect(errors).toHaveLength(2);
    expect(handled).toBe(0);
    expect(dropped).toBe(1);
    expect(inputs.pending).toBe(0);

    for (let index = 0; index < 1_000; index += 1) {
      inputs.enqueue(() => { handled += 1; }, () => { dropped += 1; });
    }
    expect(controlled.renderRequests()).toBe(4);
    expect(inputs.pending).toBe(0);
    expect(handled).toBe(0);
    expect(dropped).toBe(1_001);
    runtime.requestInputRecovery();
    expect(controlled.renderRequests()).toBe(4);

    runtime.dispose();
  });

  test("width resize naturally builds its uncached measure before admitting input", async () => {
    const controlled = createControlledRenderer(120, 36);
    const source = demoAppSource(false);
    source.payload = syntheticStoryPayload(500, 150);
    const state = initialState(source, false);
    const wrapCache = createWrapCache<ProseStyle>();
    const initial = renderStoryScreen(state, { width: 120, height: 36, wrapCache });
    const initialCacheEpoch = wrapCache.epoch;
    const widePlan = storyFrameWrapPlans(
      state, deriveStoryFrameLayout(120, state.config)
    )[0]!;
    expect(wrapCache.isWarm(
      widePlan.partId, widePlan.width, widePlan.text, widePlan.runs, widePlan.identity
    )).toBeTrue();
    Object.assign(state, initial.derived);
    const wideViewportStart = state.lastViewportStart;
    const surface: StorySurface = {
      paint() {},
      setPageSelectable() {},
      setBackground() {},
      onMouse() {}
    };
    let built: { version: number; interactive: boolean; frameToken: number } | null = null;
    let presentedFrameToken = 0;
    let inputs: PresentedInputQueue | null = null;
    let resolveNarrow!: () => void;
    const narrowBuilt = new Promise<void>((resolve) => { resolveNarrow = resolve; });
    const runtime = createInteractiveFrameRuntime({
      state,
      renderer: controlled.renderer,
      surface,
      palette: () => createPalette("lantern", "256"),
      wrapCache,
      onBuilt(version, interactive, frameToken) {
        built = { version, interactive, frameToken };
        if (interactive && frameToken > 1) resolveNarrow();
      },
      onPresented(frameToken) {
        presentedFrameToken = frameToken;
        inputs?.presented();
      },
      onError: (error) => { throw error; }
    });
    inputs = createPresentedInputQueue({
      flush: () => runtime.flush(),
      ready: () => built?.interactive === true
        && built.version === runtime.version
        && built.frameToken === presentedFrameToken
    });

    runtime.invalidate();
    runtime.flush();
    controlled.present(1);

    controlled.resize(60, 20);
    runtime.invalidate("resize");
    let reducerViewportStart: number | null = null;
    inputs.enqueue(() => { reducerViewportStart = state.lastViewportStart; });

    expect(built).toMatchObject({ version: 2, interactive: false });
    expect(wrapCache.epoch).toBe(initialCacheEpoch + 1);
    expect(wrapCache.isWarm(
      widePlan.partId, widePlan.width, widePlan.text, widePlan.runs, widePlan.identity
    )).toBeFalse();
    expect(state.lastViewportStart).toBe(wideViewportStart);
    expect(reducerViewportStart).toBe(null);

    controlled.present(1);
    controlled.present(2);
    expect(reducerViewportStart).toBe(null);

    const timeout = setTimeout(resolveNarrow, 2_000);
    await narrowBuilt;
    clearTimeout(timeout);
    const narrowPlan = storyFrameWrapPlans(
      state, deriveStoryFrameLayout(60, state.config)
    )[0]!;
    expect(wrapCache.epoch).toBe(initialCacheEpoch + 1);
    expect(wrapCache.isWarm(
      narrowPlan.partId, narrowPlan.width, narrowPlan.text, narrowPlan.runs, narrowPlan.identity
    )).toBeTrue();
    expect(state.lastViewportStart).toBeGreaterThan(wideViewportStart);
    expect(reducerViewportStart).toBe(null);

    controlled.present(3);
    expect(reducerViewportStart).toBe(state.lastViewportStart);

    runtime.dispose();
  });

  test("height and same-measure width resizes keep a warm story interactive", () => {
    const controlled = createControlledRenderer(120, 36);
    const source = demoAppSource(false);
    source.payload = syntheticStoryPayload(500, 150);
    const state = initialState(source, false);
    const wrapCache = createWrapCache<ProseStyle>();
    renderStoryScreen(state, { width: 120, height: 36, wrapCache });
    const initialCacheEpoch = wrapCache.epoch;
    const initialCacheRevision = wrapCache.revision;
    const builds: Array<{ version: number; interactive: boolean }> = [];
    const runtime = createInteractiveFrameRuntime({
      state,
      renderer: controlled.renderer,
      surface: {
        paint() {},
        setPageSelectable() {},
        setBackground() {},
        onMouse() {}
      },
      palette: () => createPalette("lantern", "256"),
      wrapCache,
      onBuilt(version, interactive) {
        builds.push({ version, interactive });
      },
      onError: (error) => { throw error; },
      profile: true
    });

    runtime.invalidate();
    runtime.flush();
    controlled.present(1);
    controlled.resize(120, 20);
    runtime.invalidate("resize");
    runtime.flush();
    controlled.present(2);
    controlled.resize(130, 20);
    runtime.invalidate("resize");
    runtime.flush();

    expect(builds).toEqual([
      { version: 1, interactive: true },
      { version: 2, interactive: true },
      { version: 3, interactive: true }
    ]);
    expect(wrapCache.epoch).toBe(initialCacheEpoch);
    expect(wrapCache.revision).toBe(initialCacheRevision);
    expect(runtime.profile(null)!.application.loadingFrames).toBe(0);
    runtime.dispose();
  });

  test("a failed cold-resize loading paint is repainted by its input retry", () => {
    const controlled = createControlledRenderer(120, 36);
    const source = demoAppSource(false);
    source.payload = syntheticStoryPayload(500, 150);
    const state = initialState(source, false);
    const wrapCache = createWrapCache<ProseStyle>();
    renderStoryScreen(state, { width: 120, height: 36, wrapCache });
    let paints = 0;
    let failNarrowPaint = true;
    const built: Array<{ interactive: boolean; frameToken: number }> = [];
    const errors: unknown[] = [];
    const runtime = createInteractiveFrameRuntime({
      state,
      renderer: controlled.renderer,
      surface: {
        paint() {
          paints += 1;
          if (controlled.renderer.width === 60 && failNarrowPaint) {
            failNarrowPaint = false;
            throw new Error("loading paint failed");
          }
        },
        setPageSelectable() {},
        setBackground() {},
        onMouse() {}
      },
      palette: () => createPalette("lantern", "256"),
      wrapCache,
      onBuilt(_version, interactive, frameToken) {
        built.push({ interactive, frameToken });
      },
      onError: (error) => { errors.push(error); }
    });

    runtime.invalidate();
    runtime.flush();
    controlled.present(1);
    expect(paints).toBe(1);

    controlled.resize(60, 20);
    runtime.invalidate("resize");
    runtime.flush();
    expect(runtime.failed).toBeTrue();
    expect(paints).toBe(2);
    expect(errors).toHaveLength(1);

    controlled.present(2);
    expect(runtime.failed).toBeTrue();
    runtime.flush();
    expect(paints).toBe(3);
    expect(built.at(-1)?.interactive).toBeFalse();
    controlled.present(3);
    expect(runtime.failed).toBeFalse();

    runtime.dispose();
  });

  test("a failed cold-resize native presentation retries without repainting", async () => {
    const controlled = createControlledRenderer(120, 36);
    const source = demoAppSource(false);
    source.payload = syntheticStoryPayload(500, 150);
    const state = initialState(source, false);
    const wrapCache = createWrapCache<ProseStyle>();
    renderStoryScreen(state, { width: 120, height: 36, wrapCache });
    let paints = 0;
    const errors: unknown[] = [];
    const runtime = createInteractiveFrameRuntime({
      state,
      renderer: controlled.renderer,
      surface: {
        paint() { paints += 1; },
        setPageSelectable() {},
        setBackground() {},
        onMouse() {}
      },
      palette: () => createPalette("lantern", "256"),
      wrapCache,
      onBuilt() {},
      onError: (error) => { errors.push(error); }
    });

    runtime.invalidate();
    runtime.flush();
    controlled.present(1);
    controlled.fail(1);
    await drainMicrotasks();

    controlled.resize(60, 20);
    runtime.invalidate("resize");
    runtime.flush();
    expect(paints).toBe(2);

    controlled.fail(2);
    await drainMicrotasks();
    controlled.fail(3);
    await drainMicrotasks();
    expect(runtime.failed).toBeTrue();
    expect(errors).toHaveLength(1);

    runtime.flush();
    expect(paints).toBe(2);
    controlled.present(4);
    expect(runtime.failed).toBeFalse();

    runtime.dispose();
  });

  test("scroll intent survives a flush while cold derivation is still building", async () => {
    const setup = await createTestRenderer({ width: 120, height: 36 });
    const source = demoAppSource(false);
    source.payload = syntheticStoryPayload(500, 150);
    const state = initialState(source, false);
    state.lastViewportStart = 777;
    const wrapCache = createWrapCache<ProseStyle>();
    const painted: Parameters<StorySurface["paint"]>[0][] = [];
    const surface: StorySurface = {
      paint(frame) { painted.push(frame); },
      setPageSelectable() {},
      setBackground() {},
      onMouse() {}
    };
    const builds: Array<{ interactive: boolean; frameToken: number }> = [];
    let resolveFinal!: () => void;
    const final = new Promise<void>((resolve) => { resolveFinal = resolve; });
    const runtime = createInteractiveFrameRuntime({
      state,
      renderer: setup.renderer,
      surface,
      palette: () => createPalette("lantern", "256"),
      wrapCache,
      onBuilt(_version, interactive, frameToken) {
        builds.push({ interactive, frameToken });
        if (interactive) resolveFinal();
      },
      onError: (error) => { throw error; },
      profile: true
    });

    runtime.invalidate();
    expect(builds).toHaveLength(1);
    expect(builds.at(-1)?.interactive).toBeFalse();
    expect(painted[0]?.some((line) => plainLine(line).includes("opening wrap test"))).toBeTrue();
    setup.renderer.resize(120, 20);
    runtime.invalidate("resize");
    runtime.flush();
    expect(builds).toHaveLength(2);
    expect(builds.at(-1)?.interactive).toBeFalse();
    expect(builds[1]!.frameToken).toBeGreaterThan(builds[0]!.frameToken);
    scrollStoryViewport(state, 1);
    runtime.invalidate();

    const timeout = setTimeout(() => resolveFinal(), 2_000);
    await final;
    clearTimeout(timeout);

    expect(builds.at(-1)?.interactive).toBeTrue();
    expect(state.viewScrollDelta).toBe(0);
    expect(state.viewScroll).not.toBe(778);
    expect(state.lastViewportStart).toBeGreaterThan(777);
    expect(wrapCache.epoch).toBe(0);
    expect(runtime.profile(null)!.wrap).toMatchObject({
      coldBuildsCompleted: 1,
      coldBuildsReplaced: 0
    });

    runtime.dispose();
    setup.renderer.destroy();
  });

  test("a cross-story cold replacement presents a noninteractive loading owner", async () => {
    const setup = await createTestRenderer({ width: 120, height: 36 });
    const state = initialState(demoAppSource(false), false);
    const wrapCache = createWrapCache<ProseStyle>();
    renderStoryScreen(state, { width: 120, height: 36, wrapCache });
    const initialCacheEpoch = wrapCache.epoch;
    const painted: Parameters<StorySurface["paint"]>[0][] = [];
    const built: Array<{ version: number; interactive: boolean; frameToken: number }> = [];
    let resolveReady: (() => void) | null = null;
    const waitForReady = () => new Promise<void>((resolve) => { resolveReady = resolve; });
    const palette = createPalette("lantern", "256");
    const renderedSurface = createStorySurface(setup.renderer, palette);
    const surface: StorySurface = {
      paint(frame, activePalette, layout, selectable, options) {
        painted.push(frame);
        renderedSurface.paint(frame, activePalette, layout, selectable, options);
      },
      setPageSelectable: (selectable) => renderedSurface.setPageSelectable(selectable),
      setBackground: (color) => renderedSurface.setBackground(color),
      onMouse: (handler) => renderedSurface.onMouse(handler)
    };
    const runtime = createInteractiveFrameRuntime({
      state,
      renderer: setup.renderer,
      surface,
      palette: () => palette,
      wrapCache,
      onBuilt(version, interactive, frameToken) {
        built.push({ version, interactive, frameToken });
        if (interactive) {
          resolveReady?.();
          resolveReady = null;
        }
      },
      onError: (error) => { throw error; },
      profile: true
    });

    const initialReady = waitForReady();
    runtime.invalidate();
    runtime.flush();
    await initialReady;
    await setup.renderOnce();
    const proseRow = painted.at(-1)!.findIndex((line) =>
      line.some((part) => part.storySource !== undefined));
    expect(proseRow).toBeGreaterThan(-1);
    const page = setup.renderer.root.findDescendantById("story") as TextRenderable;
    setup.renderer.startSelection(page, 0, proseRow);
    setup.renderer.updateSelection(page, 5, proseRow, { finishDragging: true });
    expect(setup.renderer.getSelection()).not.toBe(null);

    const replacementReady = waitForReady();
    state.payload = {
      ...syntheticStoryPayload(500, 150),
      id: "replacement-story",
      title: "replacement story"
    };
    runtime.invalidate();
    runtime.flush();

    expect(built.at(-1)).toMatchObject({ version: 2, interactive: false });
    expect(painted.at(-1)?.map(plainLine).join("\n")).toContain("opening replacement story");
    expect(state.hitRows.every((row) => row === null)).toBeTrue();
    expect(setup.renderer.getSelection()).toBe(null);
    expect(page.selectable).toBeFalse();
    setup.renderer.startSelection(page, 0, Math.floor(setup.renderer.height / 2));
    setup.renderer.updateSelection(page, 5, Math.floor(setup.renderer.height / 2), {
      finishDragging: true
    });
    expect(setup.renderer.getSelection()).toBe(null);
    const loadingToken = built.at(-1)!.frameToken;

    setup.renderer.resize(60, 20);
    runtime.invalidate("resize");
    runtime.flush();
    expect(built.at(-1)).toMatchObject({ version: 3, interactive: false });
    expect(built.at(-1)!.frameToken).toBeGreaterThan(loadingToken);
    expect(painted.at(-1)).toHaveLength(20);
    expect(plainLine(painted.at(-1)![10]!)).toContain("opening replacement story");

    const timeout = setTimeout(() => resolveReady?.(), 2_000);
    await replacementReady;
    clearTimeout(timeout);
    expect(built.at(-1)).toMatchObject({ version: 3, interactive: true });
    expect(built.at(-1)!.frameToken).toBeGreaterThan(loadingToken);
    expect(page.selectable).toBeTrue();
    expect(wrapCache.epoch).toBe(initialCacheEpoch + 1);
    expect(runtime.profile(null)!.wrap).toMatchObject({
      coldBuildsCompleted: 2,
      coldBuildsReplaced: 1
    });

    runtime.dispose();
    setup.renderer.destroy();
  });

  test("discarded input can request one frame recovery without admitting stale data", async () => {
    const setup = await createTestRenderer({ width: 120, height: 36 });
    const state = initialState(demoAppSource(false), false);
    const wrapCache = createWrapCache<ProseStyle>();
    renderStoryScreen(state, { width: 120, height: 36, wrapCache });
    const errors: unknown[] = [];
    const built: Array<{ interactive: boolean; frameToken: number }> = [];
    let handled = 0;
    let quitRequests = 0;
    let fail = true;
    const surface: StorySurface = {
      paint() {
        if (!fail) return;
        fail = false;
        throw new Error("one-shot surface failure");
      },
      setPageSelectable() {},
      setBackground() {},
      onMouse() {}
    };
    let runtime!: ReturnType<typeof createInteractiveFrameRuntime>;
    const inputs = createPresentedInputQueue({
      flush: () => runtime.flush(),
      ready: () => false
    });
    runtime = createInteractiveFrameRuntime({
      state,
      renderer: setup.renderer,
      surface,
      palette: () => createPalette("lantern", "256"),
      wrapCache,
      onBuilt(_version, interactive, frameToken) {
        built.push({ interactive, frameToken });
      },
      onPresentationFailure: inputs.presentationFailed,
      onError: (error) => errors.push(error)
    });

    inputs.enqueue(() => { handled += 1; });
    inputs.enqueue(() => { handled += 1; }, () => { quitRequests += 1; });
    runtime.invalidate();
    const failedToken = runtime.frameToken;
    expect(errors).toHaveLength(1);
    expect(runtime.failed).toBeTrue();
    expect(built).toHaveLength(0);
    expect(handled).toBe(0);
    expect(quitRequests).toBe(1);
    expect(inputs.pending).toBe(0);

    runtime.requestInputRecovery();
    expect(runtime.frameToken).toBeGreaterThan(failedToken);
    expect(built).toEqual([{ interactive: true, frameToken: runtime.frameToken }]);
    await setup.renderer.idle();
    expect(runtime.failed).toBeFalse();

    runtime.dispose();
    setup.renderer.destroy();
  });
});
