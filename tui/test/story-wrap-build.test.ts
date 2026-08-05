import { describe, expect, test } from "bun:test";
import type { StoryPayload } from "../../shared/types.js";
import { initialState } from "../src/app.js";
import { demoAppSource } from "../src/demo.js";
import { deriveStoryFrameLayout } from "../src/story-frame-layout.js";
import {
  createStoryWrapBuild,
  storyFrameWrapPlans,
  type WrapBuildClock
} from "../src/story-wrap-build.js";
import { createWrapCache, wrapText, type ProseStyle } from "../src/wrap.js";
import { syntheticStoryPayload as payload } from "./fixtures/story.js";
import {
  initialSettingsOverlay,
  SETTINGS_ROW_IDS
} from "../src/settings-overlay-model.js";
import { openSystemPromptEditor } from "../src/editor-open.js";

function stateFor(story: StoryPayload) {
  const source = demoAppSource(false);
  source.payload = story;
  return initialState(source, false);
}

function fakeClock(stepMs = 0.2) {
  let now = 0;
  const queued: Array<() => void> = [];
  const clock: WrapBuildClock = {
    now: () => (now += stepMs),
    yield: (callback) => queued.push(callback)
  };
  return {
    clock,
    drain(limit = 10_000) {
      let turns = 0;
      while (queued.length > 0) {
        if (++turns > limit) throw new Error("wrap build did not settle");
        queued.shift()!();
      }
      return turns;
    },
    pending: () => queued.length
  };
}

describe("sliced story wrap build", () => {
  test("stress fixtures contain their declared word count", () => {
    expect(payload(1, 150).path[0]!.text.split(/\s+/)).toHaveLength(150);
    expect(payload(1, 10_000).path[0]!.text.split(/\s+/)).toHaveLength(10_000);
  });

  test("warms a 75k-word story in bounded slices", () => {
    const state = stateFor(payload(500, 150));
    const cache = createWrapCache<ProseStyle>();
    const fake = fakeClock();
    let ready = 0;
    const build = createStoryWrapBuild(cache, {
      clock: fake.clock,
      sliceMs: 8,
      onReady: () => { ready += 1; }
    });
    const layout = deriveStoryFrameLayout(120, state.config);

    expect(build.ensure(state, layout)).toBe("building");
    expect(fake.drain()).toBeGreaterThan(1);
    expect(ready).toBe(1);
    expect(build.ensure(state, layout)).toBe("ready");
    expect(build.stats().maxSliceMs <= 8.5).toBeTrue();
  });

  test("plan generation and an all-warm cache scan stay inside work slices", () => {
    const state = stateFor(payload(2_000, 1));
    const cache = createWrapCache<ProseStyle>();
    const layout = deriveStoryFrameLayout(120, state.config);
    for (const plan of storyFrameWrapPlans(state, layout)) {
      cache.wrap(plan.partId, plan.width, plan.text, plan.runs, plan.identity);
    }
    const fake = fakeClock();
    let ready = 0;
    const build = createStoryWrapBuild(cache, {
      clock: fake.clock,
      onReady: () => { ready += 1; }
    });

    expect(build.ensure(state, layout)).toBe("building");
    expect(fake.drain()).toBeGreaterThan(1);
    expect(ready).toBe(1);
    expect(build.stats().maxSliceMs <= 6.5).toBeTrue();
    const completedSlices = build.stats().slices;
    expect(build.ensure(state, layout)).toBe("ready");
    expect(build.stats().slices).toBe(completedSlices);
  });

  test("cache mutation and text revert invalidate an older ready proof", () => {
    const state = stateFor(payload(1, 10_000));
    const cache = createWrapCache<ProseStyle>();
    const fake = fakeClock();
    const build = createStoryWrapBuild(cache, {
      clock: fake.clock,
      onReady: () => undefined
    });
    const layout = deriveStoryFrameLayout(120, state.config);

    expect(build.ensure(state, layout)).toBe("building");
    fake.drain();
    expect(build.ensure(state, layout)).toBe("ready");
    expect(build.stats().completed).toBe(1);

    const node = state.payload.path[0]!;
    const originalText = node.text;
    node.text = `${originalText} changed`;
    const [changed] = storyFrameWrapPlans(state, layout);
    cache.wrap(
      changed!.partId,
      changed!.width,
      changed!.text,
      changed!.runs,
      changed!.identity
    );
    node.text = originalText;
    const [original] = storyFrameWrapPlans(state, layout);
    expect(cache.isWarm(
      original!.partId,
      original!.width,
      original!.text,
      original!.runs,
      original!.identity
    )).toBeFalse();

    expect(build.ensure(state, layout)).toBe("building");
    fake.drain();
    expect(build.ensure(state, layout)).toBe("ready");
    expect(build.stats().completed).toBe(2);
  });

  test("yields inside one long paragraph and withholds its partial cache entry", () => {
    const state = stateFor(payload(1, 10_000));
    const cache = createWrapCache<ProseStyle>();
    const fake = fakeClock();
    const build = createStoryWrapBuild(cache, {
      clock: fake.clock,
      sliceMs: 8,
      onReady: () => undefined
    });
    const layout = deriveStoryFrameLayout(120, state.config);
    const [plan] = storyFrameWrapPlans(state, layout);

    expect(build.ensure(state, layout)).toBe("building");
    expect(fake.pending()).toBe(1);
    expect(cache.isWarm(
      plan!.partId,
      plan!.width,
      plan!.text,
      plan!.runs,
      plan!.identity
    )).toBeFalse();
    expect(fake.drain()).toBeGreaterThan(1);
    expect(cache.isWarm(
      plan!.partId,
      plan!.width,
      plan!.text,
      plan!.runs,
      plan!.identity
    )).toBeTrue();
  });

  test("resolves a long Unicode append seam inside bounded wrap slices", () => {
    const story = payload(1, 1);
    const node = story.path[0]!;
    node.text = `${"界".repeat(10_000)}e`;
    const state = stateFor(story);
    state.stream = {
      targetId: node.id,
      parentId: node.parentId,
      append: true,
      startedAt: "2026-07-23T00:00:00Z",
      instruction: "",
      text: "\u0301 tail"
    };
    const cache = createWrapCache<ProseStyle>();
    const fake = fakeClock();
    const build = createStoryWrapBuild(cache, {
      clock: fake.clock,
      onReady: () => undefined
    });
    const layout = deriveStoryFrameLayout(120, state.config);

    expect(build.ensure(state, layout)).toBe("building");
    expect(fake.drain()).toBeGreaterThan(1);
    expect(build.stats().maxSliceMs <= 6.5).toBeTrue();

    const [plan] = storyFrameWrapPlans(state, layout);
    const lines = cache.wrap(
      plan!.partId,
      plan!.width,
      plan!.text,
      plan!.runs,
      plan!.identity
    );
    const streamingStart = lines.flatMap((line) =>
      line.styleRuns
        .filter((run) => run.style === "streaming")
        .map((run) => line.start + run.start)
    )[0];
    expect(streamingStart).toBe(node.text.length - 1);
  });

  test("append-prefix reuse rewraps the prior final grapheme at a Unicode seam", () => {
    const story = payload(1, 1);
    const node = story.path[0]!;
    node.text = `${"word ".repeat(10_000)}e`;
    const state = stateFor(story);
    const cache = createWrapCache<ProseStyle>();
    const layout = deriveStoryFrameLayout(120, state.config);
    const [settled] = storyFrameWrapPlans(state, layout);
    cache.wrap(
      settled!.partId,
      settled!.width,
      settled!.text,
      settled!.runs,
      settled!.identity
    );
    state.stream = {
      targetId: node.id,
      parentId: node.parentId,
      append: true,
      startedAt: "2026-07-23T00:00:00Z",
      instruction: "",
      text: "\u0301 tail"
    };
    const fake = fakeClock();
    const build = createStoryWrapBuild(cache, {
      clock: fake.clock,
      onReady: () => undefined
    });

    build.ensure(state, layout);
    fake.drain();

    const [plan] = storyFrameWrapPlans(state, layout);
    expect(cache.wrap(
      plan!.partId,
      plan!.width,
      plan!.text,
      plan!.runs,
      plan!.identity
    ))
      .toEqual(wrapText(plan!.text, plan!.runs, plan!.width));
    const streamingStart = cache.wrap(
      plan!.partId,
      plan!.width,
      plan!.text,
      plan!.runs,
      plan!.identity
    ).flatMap((line) =>
      line.styleRuns
        .filter((run) => run.style === "streaming")
        .map((run) => line.start + run.start)
    )[0];
    expect(streamingStart).toBe(node.text.length - 1);
  });

  test("reuses the stable wrapped prefix across rapid append replacements", () => {
    const story = payload(1, 10_000);
    const state = stateFor(story);
    const cache = createWrapCache<ProseStyle>();
    const layout = deriveStoryFrameLayout(120, state.config);
    const [settled] = storyFrameWrapPlans(state, layout);
    cache.wrap(
      settled!.partId,
      settled!.width,
      settled!.text,
      settled!.runs,
      settled!.identity
    );
    const fake = fakeClock(1);
    const build = createStoryWrapBuild(cache, {
      clock: fake.clock,
      onReady: () => undefined
    });
    const node = state.payload.path[0]!;
    state.stream = {
      targetId: node.id,
      parentId: node.parentId,
      append: true,
      startedAt: "2026-07-23T00:00:00Z",
      instruction: "",
      text: " first"
    };

    expect(build.ensure(state, layout)).toBe("building");
    state.stream.text += " second";
    expect(build.ensure(state, layout)).toBe("building");
    state.stream.text += " third";
    expect(build.ensure(state, layout)).toBe("building");
    expect(build.stats().replaced).toBe(2);

    expect(fake.drain()).toBeGreaterThan(0);
    expect(build.ensure(state, layout)).toBe("ready");
    expect(build.stats().maxSliceMs <= 7).toBeTrue();
    const [appended] = storyFrameWrapPlans(state, layout);
    const warmed = cache.wrap(
      appended!.partId,
      appended!.width,
      appended!.text,
      appended!.runs,
      appended!.identity
    );
    expect(warmed).toEqual(wrapText(appended!.text, appended!.runs, appended!.width));
  });

  test("falls back to full resumable work when an append candidate is stale", () => {
    const story = payload(1, 2_000);
    const state = stateFor(story);
    const cache = createWrapCache<ProseStyle>();
    const layout = deriveStoryFrameLayout(120, state.config);
    const [stale] = storyFrameWrapPlans(state, layout);
    cache.wrap(
      stale!.partId,
      stale!.width,
      stale!.text,
      stale!.runs,
      stale!.identity
    );
    const node = state.payload.path[0]!;
    node.text = `X${node.text.slice(1)}`;
    state.stream = {
      targetId: node.id,
      parentId: node.parentId,
      append: true,
      startedAt: "2026-07-23T00:00:00Z",
      instruction: "",
      text: " appended"
    };
    const fake = fakeClock();
    const build = createStoryWrapBuild(cache, {
      clock: fake.clock,
      onReady: () => undefined
    });

    expect(build.ensure(state, layout)).toBe("building");
    expect(fake.drain()).toBeGreaterThan(1);

    const [current] = storyFrameWrapPlans(state, layout);
    expect(cache.wrap(
      current!.partId,
      current!.width,
      current!.text,
      current!.runs,
      current!.identity
    ))
      .toEqual(wrapText(current!.text, current!.runs, current!.width));
    expect(build.stats().maxSliceMs <= 6.5).toBeTrue();
  });

  test("focus changes retain the same owner while story changes replace it", () => {
    const state = stateFor(payload(200, 150));
    const cache = createWrapCache<ProseStyle>();
    const fake = fakeClock();
    let ready = 0;
    const build = createStoryWrapBuild(cache, {
      clock: fake.clock,
      onReady: () => { ready += 1; }
    });
    const layout = deriveStoryFrameLayout(120, state.config);

    expect(build.ensure(state, layout)).toBe("building");
    state.focusIndex = 10;
    expect(build.ensure(state, layout)).toBe("building");
    expect(build.stats().replaced).toBe(0);
    state.payload = payload(100, 150, "replacement");
    expect(build.ensure(state, layout)).toBe("building");
    expect(build.stats().replaced).toBe(1);
    fake.drain();
    expect(ready).toBe(1);
  });

  for (const surface of [
    "map",
    "editor",
    "system prompt",
    "fullscreen compose"
  ] as const) {
    test(`${surface} renders immediately without replacing the underlying prose owner`, () => {
      const state = stateFor(payload(100, 150));
      const cache = createWrapCache<ProseStyle>();
      const fake = fakeClock();
      const build = createStoryWrapBuild(cache, {
        clock: fake.clock,
        onReady: () => undefined
      });
      const layout = deriveStoryFrameLayout(120, state.config);
      const leaf = state.payload.path.at(-1)!;
      const hideProse = () => {
        if (surface === "map") {
          state.mode = "MAP";
          state.map = {
            view: "path",
            pathCursorId: leaf.id,
            treeCursorId: leaf.id,
            rowIds: [],
            pathShowAllTakes: true,
            showSketches: false,
            openedColdFolds: new Set(),
            massSort: "size"
          };
        } else if (surface === "editor") {
          state.mode = "EDITOR";
          state.editor = {
            kind: "document",
            target: {
              kind: "part",
              node: leaf,
              pathIndex: state.payload.path.length - 1,
              savedNode: null
            },
            composer: state.composer,
            initial: leaf.text,
            title: "edit part",
            placeholder: "",
            returnMode: "NAV",
            conflict: null
          };
        } else if (surface === "system prompt") {
          state.mode = "EDITOR";
          state.settings = initialSettingsOverlay(
            demoAppSource(false).settingsView,
            state.config
          );
          state.settings.cursor = SETTINGS_ROW_IDS.indexOf("system-prompt");
          openSystemPromptEditor(state);
        } else {
          state.mode = "COMPOSE";
          state.composer.fullscreen = true;
        }
      };
      const showProse = () => {
        state.mode = "NAV";
        state.settings = null;
        state.composer.fullscreen = false;
      };

      hideProse();
      expect(build.ensure(state, layout)).toBe("ready");
      expect(fake.pending()).toBe(1);
      expect(build.ensure(state, layout)).toBe("ready");
      expect(build.stats().replaced).toBe(0);

      showProse();
      expect(build.ensure(state, layout)).toBe("building");
      expect(build.stats().replaced).toBe(0);
      hideProse();
      expect(build.ensure(state, layout)).toBe("ready");
      expect(build.stats().replaced).toBe(0);

      expect(fake.drain()).toBeGreaterThan(1);
      showProse();
      expect(build.ensure(state, layout)).toBe("ready");
      expect(build.stats()).toMatchObject({ completed: 1, replaced: 0 });
    });
  }

  test("dispose prevents queued completion", () => {
    const state = stateFor(payload(100, 150));
    const fake = fakeClock();
    let ready = 0;
    const build = createStoryWrapBuild(createWrapCache(), {
      clock: fake.clock,
      onReady: () => { ready += 1; }
    });
    expect(build.ensure(state, deriveStoryFrameLayout(120, state.config))).toBe("building");
    build.dispose();
    fake.drain();
    expect(ready).toBe(0);
  });

  test("reports a failed plan once without retrying it forever", () => {
    const state = stateFor(payload(1, 100));
    const base = createWrapCache<ProseStyle>();
    const cache = { ...base, prime() { throw new Error("cache write failed"); } };
    const errors: unknown[] = [];
    const build = createStoryWrapBuild(cache, {
      onReady: () => undefined,
      onError: (error) => errors.push(error)
    });
    const layout = deriveStoryFrameLayout(120, state.config);

    expect(build.ensure(state, layout)).toBe("ready");
    expect(build.ensure(state, layout)).toBe("ready");
    expect(errors).toHaveLength(1);
  });
});
