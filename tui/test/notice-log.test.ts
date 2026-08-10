import { describe, expect, test } from "bun:test";
import type { CliRenderer, KeyEvent } from "@opentui/core";
import { ActionRuntime } from "../src/action-runtime.js";
import { handleKey, initialState } from "../src/app.js";
import { demoAppSource } from "../src/demo.js";
import { hitAt } from "../src/hit.js";
import { recordNotice } from "../src/notice-log.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText, plainLine, visibleWidth } from "../src/screens/story/frame.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";

/** `F` pins or unpins the facts rail and always reports what it did, so it is
 *  the simplest real notice to raise through the real dispatcher.
 *
 *  `rendererSize`, when given, stands in for the real `CliRenderer` so a
 *  test can drive an action that reads `context.renderer?.width`/`?.height`
 *  (the log's page-scroll clamp) with the same dimensions `screen()` renders
 *  at below, rather than the no-renderer fallback every other test here
 *  exercises. */
function harness(rendererSize: { width: number; height: number } | null = null) {
  const source = demoAppSource();
  const state = initialState(source, false);
  const cache = createWrapCache<ProseStyle>();
  const backend = new ActionRuntime(state, () => undefined);
  const renderer = rendererSize === null ? null : rendererSize as unknown as CliRenderer;
  const press = (event: KeyEvent) => handleKey(
    event, state, source, cache, () => undefined, async () => undefined,
    () => undefined, renderer, () => undefined, () => undefined, backend
  );
  return { source, state, cache, press };
}

const key = (name: string, sequence = name, shift = false): KeyEvent => ({
  name, sequence, shift, ctrl: false, meta: false
}) as KeyEvent;

const RAIL = key("F", "F", true);

function screen(
  state: ReturnType<typeof harness>["state"],
  width = 120,
  height = 36
): string {
  return frameText(renderStoryScreen(state, {
    width, height, wrapCache: createWrapCache<ProseStyle>()
  }).lines);
}

describe("C-37 · the session log", () => {
  test("! opens a surface holding what the app said", async () => {
    const { state, press } = harness();
    await press(RAIL);
    const raised = state.toast;
    expect(raised).not.toBe(null);

    await press(key("!", "!"));
    expect(state.mode).toBe("LOG");
    const rendered = screen(state);
    expect(rendered).toContain(" LOG ");
    expect(rendered).toContain("━━ log ━ 1 notice this session");
    expect(rendered).toContain(raised!);
    // C-37's keys, in the keyline beside the breadcrumb (C-06).
    // C-37 requires every close key in the keyline, `!` included.
    expect(rendered).toContain("↑↓ move · ⇧↑↓ scroll · ↵ copies · x clears · ! or esc closes");
  });

  test("x clears the log and esc returns to the page", async () => {
    const { state, press } = harness();
    await press(RAIL);
    await press(key("!", "!"));
    expect(state.notices.entries.length).toBeGreaterThan(0);

    await press(key("x"));
    expect(state.notices.entries).toHaveLength(0);
    expect(screen(state)).toContain("nothing has gone wrong yet");

    await press(key("escape"));
    expect(state.mode).toBe("NAV");
  });

  test("one message is recorded once however many frames it survives", async () => {
    const { state, press } = harness();
    await press(RAIL);
    const raised = state.toast!;
    // Moving on does not raise it again, and it is not re-recorded either.
    await press(key("down"));
    await press(key("up"));
    expect(state.notices.entries.filter((entry) => entry.text === raised))
      .toHaveLength(1);
  });

  test("the log states a lost connection with its retry key", async () => {
    const { state, press } = harness();
    state.connection = { ...state.connection, down: true, attempt: 2 };
    await press(key("down"));
    await press(key("!", "!"));
    const rendered = screen(state);
    expect(rendered).toContain("connection lost");
    expect(rendered).toContain("R retries now");
  });

  test("the keyline's clear glyph runs the same action the key does", async () => {
    const { state, press } = harness();
    await press(RAIL);
    await press(key("!", "!"));
    const rendered = renderStoryScreen(state, {
      width: 120, height: 36, wrapCache: createWrapCache<ProseStyle>()
    });
    Object.assign(state, rendered.derived);
    const rows = rendered.lines;
    const row = rows.length - 1;
    const line = plainLine(rows[row]!);
    const column = visibleWidth(line.slice(0, line.indexOf("x clears")));

    // The keyline advertises `x`, so the glyph has to run what `x` runs.
    expect(hitAt(state.hitRows, column, row))
      .toEqual({ kind: "action", action: "clear-log" });
  });
});

describe("C-27 · the log scrolls within a notice too tall for the surface", () => {
  test("a notice taller than the surface can be scrolled to reveal its last row", async () => {
    const { state, press } = harness();
    // Feedback wraps as one flowing paragraph (Decision 24's `wrapFeedback`
    // collapses every whitespace run, including a literal newline), so
    // height comes from word count, not line count: enough words to wrap
    // well past the log's body height at width 120.
    const words = Array.from({ length: 1500 }, (_, index) => `w${index}`);
    words.push("LASTROWMARKER");
    recordNotice(state.notices, "toast", words.join(" "));

    await press(key("!", "!"));
    expect(state.mode).toBe("LOG");
    const opened = screen(state);
    expect(opened).toContain("w0 ");
    expect(opened).not.toContain("LASTROWMARKER");

    // Far more line-scrolls than the notice has rows, so this does not
    // depend on knowing the exact wrapped row count — and proves the offset
    // clamps at the notice's last row rather than scrolling past it. (This
    // harness runs with no renderer, so `pagedown`'s page falls back to one
    // row; shift+down is the same one row per press either way, and asserts
    // the same clamp without needing a real terminal height.)
    for (let line = 0; line < 80; line += 1) await press(key("down", "down", true));
    const scrolled = screen(state);
    expect(scrolled).toContain("LASTROWMARKER");
    expect(scrolled).not.toContain("w0 ");

    // Moving to a different notice resets the offset: back to the head.
    recordNotice(state.notices, "toast", "a second, shorter notice");
    await press(key("down"));
    await press(key("up"));
    expect(screen(state)).toContain("w0 ");
  });

  test("holding page-down past a notice's end does not leave page-up frozen", async () => {
    // A renderer size is required here: the clamp this test exercises reads
    // `context.renderer?.width`/`?.height`, and the plain `harness()` above
    // runs with neither.
    const { state, press } = harness({ width: 120, height: 36 });
    const words = Array.from({ length: 1500 }, (_, index) => `w${index}`);
    words.push("LASTROWMARKER");
    recordNotice(state.notices, "toast", words.join(" "));

    await press(key("!", "!"));
    expect(state.mode).toBe("LOG");

    // Far more pages than the notice has: before the fix, each press still
    // added a full page to the *stored* offset with no upper bound, even
    // though the render already clamped what that offset could show.
    for (let page = 0; page < 20; page += 1) await press(key("pagedown"));
    const atEnd = screen(state);
    expect(atEnd).toContain("LASTROWMARKER");

    // One page-up must visibly move the view. Before the fix, the
    // over-scrolled stored offset absorbed this press — and the next dozen
    // — before the rendered window moved at all: the frozen scroll this
    // finding is about.
    await press(key("pageup"));
    const afterOnePageUp = screen(state);
    expect(afterOnePageUp).not.toBe(atEnd);
    expect(afterOnePageUp).not.toContain("LASTROWMARKER");
  });

  test("a notice that fits the surface does not move when scrolled", async () => {
    const { state, press } = harness();
    recordNotice(state.notices, "toast", "a short notice that fits on one screen");

    await press(key("!", "!"));
    expect(state.mode).toBe("LOG");
    const before = screen(state);

    await press(key("down", "down", true));
    await press(key("pagedown"));
    expect(screen(state)).toBe(before);
  });
});

describe("decision 24 · feedback wraps before it truncates", () => {
  test("a toast wraps into a hanging indent instead of clipping", () => {
    const { state } = harness();
    state.toast = "pruned take 3 and the 7 parts below it · 2,140 words · u undoes";
    const rows = screen(state).split("\n");
    const first = rows.findIndex((line) => line.includes("pruned take 3"));

    expect(first).toBeGreaterThan(-1);
    // The `›` glyph never repeats, so the block still reads as one event, and
    // the last row is the one that names the undo key.
    expect(rows[first]).toContain("›  pruned take 3");
    expect(rows[first + 1]).not.toContain("›");
    expect(rows.slice(first, first + 4).join("\n")).toContain("u undoes");
  });

  test("past the cap the body truncates and the recovery keys survive", () => {
    const { state } = harness();
    state.toast = "the provider returned 400: model 'gpt-4o-mini' is not available on"
      + " this key. check the model name, check the base URL, check whether the key"
      + " has access to that model at all, and check that the account behind the key"
      + " is not out of credit or rate limited right now · , opens settings";
    const rendered = screen(state);

    expect(rendered).toContain("…");
    // The tail carries the way out, and `!` reaches the whole message.
    expect(rendered).toContain("! full · , opens settings");
  });
});
