import { describe, expect, test } from "bun:test";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText } from "../src/screens/story/frame.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";
import {
  key,
  openSettings,
  selectRow,
  settingsHarness
} from "./settings-test-harness.js";

/** The panel as the writer sees it, at the 120-column primary target. */
function screen(
  state: ReturnType<typeof settingsHarness>["state"],
  width = 120,
  height = 40
): string {
  return frameText(renderStoryScreen(state, {
    width,
    height,
    wrapCache: createWrapCache<ProseStyle>()
  }).lines);
}

/** The control rounds to its own decimals, so the expectation does too. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

describe("the settings form follows C-03 and C-08", () => {
  test("draws a jump rail, a divider on every row, and section rules", async () => {
    const { state, press } = settingsHarness();
    await openSettings(press);
    const rendered = screen(state);
    const rows = rendered.split("\n").filter((line) => line.includes("│"));

    expect(rendered).toContain("── app ");
    expect(rendered).toContain("── connection ");
    expect(rendered).toContain("── generation ");
    // The rail names the section the cursor is in, and the divider runs on
    // every row of the split, blanks and section rules included.
    expect(rendered).toContain("app         │");
    expect(rows.length).toBeGreaterThan(10);
    for (const row of rows) expect(row.indexOf("│")).toBe(rows[0]!.indexOf("│"));
  });

  test("a settable number wears a chip, a positional track and a default tick", async () => {
    const { state, press } = settingsHarness();
    await openSettings(press);
    await selectRow(press, state, "temperature");
    const rendered = screen(state);

    // Law 2: a settable number wears `‹ ›`. The track is positional, filled to
    // a `◆` handle, with `┊` where the shipped default sits.
    expect(rendered).toMatch(/temperature\s+‹ \d\.\d\d ›/);
    expect(rendered).toContain("◆");
    expect(rendered).toContain("┊");
    // C-06 puts the keys in the keyline rather than repeating them per row.
    expect(rendered).toContain("←→ step · ⇧ ×10 · ↵ type");
  });

  test("arrows step, shift steps ten, and home and end reach the walls", async () => {
    const { state, press } = settingsHarness();
    await openSettings(press);
    await selectRow(press, state, "temperature");
    const start = state.settings!.draft.generation.temperature!;

    await press(key("right"));
    expect(state.settings!.draft.generation.temperature).toBe(round(start + 0.05));

    await press(key("right", { shift: true }));
    expect(state.settings!.draft.generation.temperature).toBe(round(start + 0.55));

    await press(key("end"));
    expect(state.settings!.draft.generation.temperature).toBe(2);
    await press(key("home"));
    expect(state.settings!.draft.generation.temperature).toBe(0);
  });

  test("stepping off the floor returns to the sentinel and back", async () => {
    const { state, press } = settingsHarness();
    await openSettings(press);
    await selectRow(press, state, "temperature");

    await press(key("home"));
    await press(key("left"));
    expect(state.settings!.draft.generation.temperature).toBe(null);
    expect(screen(state)).toContain("‹ ◇ default ›");

    await press(key("right"));
    expect(state.settings!.draft.generation.temperature).toBe(0.9);
  });

  test("a value past the wall pins the handle and states the limit", async () => {
    const { state, press } = settingsHarness();
    await openSettings(press);
    state.settings!.draft = {
      ...state.settings!.draft,
      generation: { ...state.settings!.draft.generation, temperature: 4 }
    };
    await selectRow(press, state, "temperature");
    const rendered = screen(state);

    // Out of range pins the handle to the wall rather than clamping the value.
    expect(rendered).toContain("▌");
    expect(rendered).toContain("max is 2.00");
  });

  test("the env-var row reports whether the shell actually holds the key", async () => {
    const { state, source, press } = settingsHarness();
    await openSettings(press);
    if (!source.settingsView.editable) throw new Error("demo settings must be editable");
    state.settings!.draft = {
      ...state.settings!.draft,
      generation: {
        ...state.settings!.draft.generation,
        apiKeyEnv: "SETTINGS_FORM_TEST_KEY"
      }
    };
    expect(screen(state)).toContain("not set in this shell");

    process.env.SETTINGS_FORM_TEST_KEY = "sk-test";
    try {
      expect(screen(state)).toContain("⚑ found in shell");
    } finally {
      delete process.env.SETTINGS_FORM_TEST_KEY;
    }
  });

  test("the check action reports in place beside the row that runs it", async () => {
    const { state, press } = settingsHarness();
    await openSettings(press);
    await selectRow(press, state, "base-url");
    expect(screen(state)).toContain("[ check connection ]");

    state.settings!.result = { state: "ready", message: "Server is reachable." };
    const rendered = screen(state);
    expect(rendered).toContain("✓ ready");
    // The provider's own sentence keeps its wrapped block, where it has room.
    expect(rendered).toContain("Server is reachable.");
  });
});
