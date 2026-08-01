import { describe, expect, test } from "bun:test";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText } from "../src/screens/story/frame.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";
import { settingsModelDiscoveryIdentity } from "../src/settings-model-discovery.js";
import {
  initialSettingsOverlay,
  settingsRows,
  SETTINGS_ROW_IDS
} from "../src/settings-overlay-model.js";
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
    // C-08's sentinel keeps the track: `◇` takes the low-bound slot so the
    // range the default sits in is still readable while the row is unset.
    expect(screen(state)).toContain("‹ default ›");
    expect(screen(state)).toContain("◇ ");

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
    state.settings!.resultRow = "base-url";
    const rendered = screen(state);
    // C-18 reports in place: the verdict rides C-07's note line under the row
    // that ran the action, and the provider's own sentence keeps the wrapped
    // block below, where it has room to say why.
    expect(rendered).toContain("· ✓ ready");
    expect(rendered).toContain("Server is reachable.");
  });
});

describe("C-15 · the model option column", () => {
  /** Nine discovered models: one past the cap C-09 puts on a cycler. */
  function withDiscoveredModels(
    state: ReturnType<typeof settingsHarness>["state"],
    count: number
  ): void {
    const overlay = state.settings!;
    overlay.draft = {
      ...overlay.draft,
      generation: { ...overlay.draft.generation, model: "model-01" }
    };
    overlay.modelDiscovery = {
      observedAt: "2026-01-01T00:00:00.000Z",
      models: Array.from({ length: count }, (_, index) => ({
        remoteId: `model-${String(index + 1).padStart(2, "0")}`,
        name: `Model ${String(index + 1).padStart(2, "0")}`,
        contextWindow: 32_768,
        maxOutputTokens: null,
        source: "openai-models" as const
      }))
    };
    overlay.modelDiscoveryIdentity =
      settingsModelDiscoveryIdentity(overlay.draft.generation);
  }

  test("a long list opens as a column that owns the arrows", async () => {
    const { state, press } = settingsHarness();
    await openSettings(press);
    withDiscoveredModels(state, 9);
    await selectRow(press, state, "model");

    // C-09 caps a cycler at eight, so `←→` no longer steps the list.
    const before = state.settings!.draft.generation.model;
    await press(key("right"));
    expect(state.settings!.draft.generation.model).toBe(before);

    await press(key("return"));
    expect(state.settings!.modelPicker).not.toBe(null);
    const rendered = screen(state);
    expect(rendered).toContain("Model 01");
    expect(rendered).toContain("9 of 9");
    expect(rendered).toContain("↑↓ move · type to narrow · ↵ choose · esc back");

    // Esc peels exactly one layer: the column, not the whole panel.
    await press(key("escape"));
    expect(state.settings!.modelPicker).toBe(null);
    expect(state.mode).toBe("SETTINGS");

    await press(key("return"));
    await press(key("down"));
    await press(key("return"));
    expect(state.settings!.modelPicker).toBe(null);
    expect(state.settings!.draft.generation.model).toBe("model-02");
  });

  test("typing narrows the column and an unmatched name is still usable", async () => {
    const { state, press } = settingsHarness();
    await openSettings(press);
    withDiscoveredModels(state, 9);
    await selectRow(press, state, "model");
    await press(key("return"));

    for (const character of "07") await press(key(character, { sequence: character }));
    expect(screen(state)).toContain("1 of 9");
    await press(key("return"));
    expect(state.settings!.draft.generation.model).toBe("model-07");

    await press(key("return"));
    for (const character of "zzz") await press(key(character, { sequence: character }));
    expect(screen(state)).toContain("no model matches · ↵ uses what you typed");
    await press(key("return"));
    expect(state.settings!.draft.generation.model).toBe("zzz");
  });
});

describe("the settings row model stays one list", () => {
  test("SETTINGS_ROW_IDS and settingsRows agree, in order", () => {
    const { source, state } = settingsHarness();
    const overlay = initialSettingsOverlay(source.settingsView, state.config);
    // The cursor indexes both: one walks the ids, the other paints the rows.
    // Nothing but this test stops a reorder in one from silently retargeting
    // every key in the panel.
    expect(settingsRows(overlay, state.config).map((row) => row.id))
      .toEqual([...SETTINGS_ROW_IDS]);
  });

  test("tab runs only the action the focused row declares", async () => {
    const { state, press } = settingsHarness();
    await openSettings(press);

    await selectRow(press, state, "temperature");
    await press(key("tab"));
    expect(state.settings!.checking).toBe(false);
    expect(state.settings!.result).toBe(null);

    await selectRow(press, state, "base-url");
    await press(key("tab"));
    // The base-URL row is the one that declares `[ check connection ]`.
    expect(state.settings!.resultRow === null || state.settings!.resultRow === "base-url")
      .toBe(true);
  });
});
