import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { ActionRuntime } from "../src/action-runtime.js";
import { handleKey, initialState } from "../src/app.js";
import { demoAppSource } from "../src/demo.js";
import { hitAt } from "../src/hit.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText, plainLine, visibleWidth } from "../src/screens/story/frame.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";

/** `F` pins or unpins the facts rail and always reports what it did, so it is
 *  the simplest real notice to raise through the real dispatcher. */
function harness() {
  const source = demoAppSource();
  const state = initialState(source, false);
  const cache = createWrapCache<ProseStyle>();
  const backend = new ActionRuntime(state, () => undefined);
  const press = (event: KeyEvent) => handleKey(
    event, state, source, cache, () => undefined, async () => undefined,
    () => undefined, null, () => undefined, () => undefined, backend
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
    expect(rendered).toContain("↑↓ move · ↵ copies · x clears · ! or esc closes");
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
