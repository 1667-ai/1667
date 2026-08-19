import { describe, expect, test } from "bun:test";
import { renderStoryScreen } from "../src/screens/story.js";
import { settingsFormRows } from "../src/screens/settings-form.js";
import { frameText, visibleWidth } from "../src/screens/story/frame.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";
import {
  DEFAULT_PROFILE_MAX_OUTPUT_TOKENS,
  DEFAULT_PROFILE_TEMPERATURE
} from "../../shared/settings-v2-types.js";
import { INITIAL_SETTINGS_DOCUMENT_V2_TEXT } from "../../server/settings-v2-initial-vectors.js";
import {
  discoverSettingsModels,
  publishCurrentSettingsModelDiscovery
} from "../src/settings-model-discovery.js";
import { detectSettingsContext } from "../src/settings-context-detection.js";
import {
  initialSettingsOverlay,
  settingsRows,
  SETTINGS_ROW_IDS
} from "../src/settings-overlay-model.js";
import { settingsRowIds } from "../src/settings-row-navigation.js";
import { SETTINGS_PROVIDER_CHOICES } from "../src/settings-provider-choices.js";
import { settingsTextDraftWithSubscriptionPlan } from "../src/settings-text.js";
import { settingsFooterVariants } from "../src/screens/settings-panel-footers.js";
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
  test("groups the form under section rules and lines its columns up", async () => {
    const { state, press } = settingsHarness();
    await openSettings(press);
    const rendered = screen(state);

    expect(rendered).toContain("── app ");
    expect(rendered).toContain("── prompt ");
    expect(rendered).toContain("── connection ");
    expect(rendered).toContain("── generation ");
    expect(rendered.indexOf("── prompt ")).toBeLessThan(rendered.indexOf("── connection "));
    expect(rendered).toContain("system");
    expect(rendered).toMatch(/↓ \d+ more settings/);
    // The rule is the section heading. It used to be printed twice — once in a
    // jump rail and again beside it — which is what made the panel read as
    // chaos, together with hints that started in a different column per row.
    expect(rendered).not.toContain("│");
    const hints = [
      "Dims the story",
      "Keeps whole words",
      "Selects the service",
      "Higher values make"
    ].map((hint) => rendered.split("\n").find((line) => line.includes(hint))!);
    expect(hints.every((line) => line !== undefined)).toBeTrue();
    const columns = new Set(hints.map((line, index) =>
      visibleWidth(line.slice(0, line.indexOf([
        "Dims the story",
        "Keeps whole words",
        "Selects the service",
        "Higher values make"
      ][index]!)))));
    expect(columns.size).toBe(1);

    await selectRow(press, state, "system-prompt");
    expect(screen(state)).toContain("Default Author Brief for prose and story names;");
    expect(screen(state)).toContain("a story brief overrides it.");
  });

  test("the selected description wraps without losing text", async () => {
    const { state, press } = settingsHarness();
    await openSettings(press);
    await selectRow(press, state, "compose-focus");
    const rendered = screen(state, 64, 24);

    expect(rendered).toContain("· Dims the story while you write in");
    expect(rendered).toContain("· the compose box.");
  });

  test("the selected description stays visible at the minimum terminal width", async () => {
    const { state, press } = settingsHarness();
    await openSettings(press);
    await selectRow(press, state, "compose-focus");
    const overlay = state.settings!;
    const rendered = frameText(settingsFormRows({
      rows: settingsRows(overlay, state.config),
      cursor: overlay.cursor,
      edit: overlay.edit,
      contentWidth: 12,
      terminalWidth: 20,
      hasArrows: () => false,
      actionReport: null
    }).map((row) => row.line));

    for (const word of ["Dims", "story", "while", "write", "compose", "box."]) {
      expect(rendered).toContain(word);
    }
  });

  test("the position line reports settings above and below the visible list", async () => {
    const { state, press } = settingsHarness();
    await openSettings(press);
    expect(/↓ \d+ more settings/.test(screen(state, 80, 24))).toBeTrue();

    await selectRow(press, state, "utility-route");
    const rendered = screen(state, 80, 24);
    expect(/↑ \d+ earlier settings/.test(rendered)).toBeTrue();
    expect(/↓ \d+ more settings/.test(rendered)).toBeFalse();

    await selectRow(press, state, "temperature");
    expect(screen(state, 40, 14)).toMatch(/↑ \d+ · ↓ \d+/);
  });

  test("save status replaces tail rows without moving the selected setting", async () => {
    const { state, press } = settingsHarness();
    await openSettings(press);
    await selectRow(press, state, "temperature");
    const row = () => screen(state, 80, 24).split("\n")
      .findIndex((line) => line.includes("temperature"));
    const clean = row();

    await press(key("right"));
    const dirty = row();
    const view = state.settings!.view;
    if (!view.editable) throw new Error("editable settings view missing");
    state.settings!.view = {
      ...view,
      pendingRevision: 2
    };

    expect(clean).toBeGreaterThan(-1);
    expect(dirty).toBe(clean);
    expect(row()).toBe(clean);
  });

  test("an exact-fit form stays still when status adds a position line", async () => {
    const { state, press } = settingsHarness();
    await openSettings(press);
    await selectRow(press, state, "reasoning");
    const row = () => screen(state, 120, 43).split("\n")
      .findIndex((line) => line.includes("reasoning"));
    expect(screen(state, 120, 43)).not.toContain("more settings");
    const clean = row();
    state.settings!.draft = {
      ...state.settings!.draft,
      generation: {
        ...state.settings!.draft.generation,
        systemPrompt: `${state.settings!.draft.generation.systemPrompt} x`
      }
    };

    expect(screen(state, 120, 43)).toContain("more settings");
    expect(row()).toBe(clean);
  });

  test("image input names a protocol limitation", async () => {
    const { state, press } = settingsHarness();
    await openSettings(press);
    await selectRow(press, state, "image-input");

    const rendered = screen(state, 80, 24);
    expect(rendered).toContain("The selected protocol cannot send image");
    expect(rendered).toContain("· attachments.");
  });

  test("the final setting keeps its description beside pending status", async () => {
    const { state, press } = settingsHarness();
    await openSettings(press);
    await selectRow(press, state, "utility-route");
    const view = state.settings!.view;
    if (!view.editable) throw new Error("editable settings view missing");
    state.settings!.view = { ...view, pendingRevision: 2 };

    for (const width of [64, 80]) {
      expect(screen(state, width, 24)).toContain("support tasks.");
    }
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
    // The sentinel opens on what a fresh profile ships with.
    expect(state.settings!.draft.generation.temperature)
      .toBe(DEFAULT_PROFILE_TEMPERATURE);
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

  test("a key is supplied one way, and the row says where it is kept", async () => {
    const { state, press } = settingsHarness();
    await openSettings(press);
    const rendered = screen(state);

    // Two rows for one job — an env var and a stored key — left every writer
    // guessing which one to fill in.
    expect(rendered).toContain("API key");
    expect(rendered).not.toContain("key env");
    // The keys live in the machine-tier state root, whose path is a platform
    // detail; what matters is that they never travel with a story.
    expect(rendered).toContain("Saved on this device");
    expect(rendered).not.toContain(".config/1667");
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
    publishCurrentSettingsModelDiscovery(overlay, {
      observedAt: "2026-01-01T00:00:00.000Z",
      models: Array.from({ length: count }, (_, index) => ({
        remoteId: `model-${String(index + 1).padStart(2, "0")}`,
        name: `Model ${String(index + 1).padStart(2, "0")}`,
        contextWindow: 32_768,
        maxOutputTokens: null,
        source: "openai-models" as const
      }))
    });
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

    // The typed identifier is always the last stop, so a name that merely
    // prefixes a discovered one is still reachable.
    await press(key("return"));
    for (const character of "model-0") await press(key(character, { sequence: character }));
    expect(screen(state)).toContain("use “model-0” as typed");
    // Nine discovered names still match, and the typed one is the stop past them.
    for (let step = 0; step < 9; step += 1) await press(key("down"));
    await press(key("return"));
    expect(state.settings!.draft.generation.model).toBe("model-0");
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

  test("subscription plans hide network controls and keep manual model entry", async () => {
    const { state, press } = settingsHarness();
    await openSettings(press);
    const overlay = state.settings!;
    overlay.draft = settingsTextDraftWithSubscriptionPlan(
      overlay.draft,
      "chatgpt-plan",
      {
        ...overlay.draft.generation,
        provider: "openai-compatible",
        baseUrl: "",
        model: "gpt-5.4",
        apiKeyEnv: null,
        contextWindow: 272_000
      }
    );
    overlay.base = overlay.draft;

    const rows = settingsRows(overlay, state.config);
    expect(rows.map((row) => row.id)).not.toContain("base-url");
    expect(rows.map((row) => row.id)).not.toContain("allow-insecure-http");
    expect(rows.map((row) => row.id)).not.toContain("api-key");
    expect(rows.find((row) => row.id === "provider")?.value)
      .toContain("ChatGPT plan");
    expect(rows.find((row) => row.id === "provider")?.hint)
      .toBe("In a terminal, run 1667 auth login chatgpt to sign in. ChatGPT output length is best effort.");
    expect(rows.find((row) => row.id === "text-prompt-format")?.disabled).toBe(true);
    expect(rows.find((row) => row.id === "text-prompt-format")?.hint)
      .toBe("Available with text-completion providers.");
    expect(rows.find((row) => row.id === "split-think-tags")?.disabled).toBe(true);
    expect(rows.find((row) => row.id === "split-think-tags")?.hint)
      .toBe("Available with text-completion providers.");
    expect(rows.map((row) => row.id)).toEqual(settingsRowIds(overlay));
    expect(settingsRowIds(overlay)).not.toContain("base-url");
    expect(settingsRowIds(overlay)).toContain("model");
    expect(overlay.draft.generation.model).toBe("gpt-5.4");

    const claude = SETTINGS_PROVIDER_CHOICES.find((choice) => choice.id === "claude-plan");
    expect(claude).toMatchObject({
      label: "Claude plan",
      provider: "anthropic",
      defaults: {
        baseUrl: "",
        model: "claude-sonnet-4-6",
        apiKeyEnv: null,
        contextWindow: 1_000_000
      }
    });
  });

  test("Claude plan help names its terminal sign-in command", async () => {
    const { state, press } = settingsHarness();
    await openSettings(press);
    const overlay = state.settings!;
    const draft = settingsTextDraftWithSubscriptionPlan(
      overlay.draft,
      "claude-plan",
      {
        ...overlay.draft.generation,
        provider: "anthropic",
        baseUrl: "",
        model: "claude-sonnet-4-6",
        apiKeyEnv: null,
        contextWindow: 1_000_000
      }
    );
    const rows = settingsRows({ ...overlay, draft }, state.config);

    expect(rows.find((row) => row.id === "provider")?.hint)
      .toBe("In a terminal, run 1667 auth login claude to sign in. Claude plan support is experimental.");
  });

  test("subscription plans skip legacy discovery and context probes", async () => {
    const { source, state, backend, press } = settingsHarness();
    await openSettings(press);
    const overlay = state.settings!;
    overlay.draft = settingsTextDraftWithSubscriptionPlan(
      overlay.draft,
      "chatgpt-plan",
      {
        ...overlay.draft.generation,
        provider: "openai-compatible",
        baseUrl: "",
        model: "gpt-5.4",
        apiKeyEnv: null,
        contextWindow: 272_000
      }
    );
    overlay.base = overlay.draft;
    let discoveryCalls = 0;
    let probeCalls = 0;
    const discoverModels = source.api.discoverModels;
    const probeContextWindow = source.api.probeContextWindow;
    source.api.discoverModels = async (...args) => {
      discoveryCalls += 1;
      return discoverModels(...args);
    };
    source.api.probeContextWindow = async (...args) => {
      probeCalls += 1;
      return probeContextWindow(...args);
    };
    const context = {
      backend,
      repaint: () => undefined,
      cache: createWrapCache<ProseStyle>(),
      renderer: null,
      applyTheme: () => undefined,
      previewTheme: () => undefined
    };

    await discoverSettingsModels(state, source, context, overlay);
    await detectSettingsContext(state, source, context, overlay);

    expect(discoveryCalls).toBe(0);
    expect(probeCalls).toBe(0);
    expect(overlay.result?.message).toContain("Enter context size manually");
  });

  test("subscription plans hide probe keys and ignore direct probe shortcuts", async () => {
    const { state, press } = settingsHarness();
    await openSettings(press);
    const overlay = state.settings!;
    overlay.draft = settingsTextDraftWithSubscriptionPlan(
      overlay.draft,
      "chatgpt-plan",
      {
        ...overlay.draft.generation,
        provider: "openai-compatible",
        baseUrl: "",
        model: "gpt-5.4",
        apiKeyEnv: null,
        contextWindow: 272_000
      }
    );
    overlay.base = overlay.draft;

    for (const row of ["provider", "context-window"] as const) {
      await selectRow(press, state, row);
      const footers = settingsFooterVariants(overlay, false);
      expect(footers.flatMap((footer) => footer.actions).map((entry) => entry.action))
        .not.toContain("check");
      expect(footers.flatMap((footer) => footer.actions).map((entry) => entry.action))
        .not.toContain("detect-context");
      expect(/(?:c check|p detect| · [cp] · | [cp] esc$)/u.test(
        footers.map((footer) => footer.text).join("\n")
      )).toBe(false);
    }

    overlay.result = null;
    overlay.deleteArmedProfileId = overlay.draft.selectedProfileId;
    await press(key("c"));
    expect(overlay.deleteArmedProfileId).toBe(null);
    await press(key("p"));
    expect(overlay.result).toBe(null);
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

describe("C-08 keeps its track through the typing state", () => {
  test("an out-of-range keystroke pins the handle and states the limit", async () => {
    const { state, press } = settingsHarness();
    await openSettings(press);
    await selectRow(press, state, "temperature");
    await press(key("return"));
    for (const character of "9") await press(key(character, { sequence: character }));
    const rendered = screen(state);

    // The chip opens to a typed field, the track follows what is typed, and
    // the wall pins the handle rather than clamping the keystroke.
    // `‹ ›` became `[ ]`, and the typed value is what the track follows.
    expect(rendered).toContain("[9");
    expect(rendered).toContain("▌");
    expect(rendered).toContain("· max is 2.00");
  });
});

describe("the shipped profile defaults are one set of numbers", () => {
  test("the C-08 ticks mark what a fresh profile actually carries", () => {
    const document = JSON.parse(INITIAL_SETTINGS_DOCUMENT_V2_TEXT) as {
      profiles: Record<string, { temperature: number; maxOutputTokens: number }>;
    };
    const profile = Object.values(document.profiles)[0]!;
    // The tick says "this is the default". It has to be the same number the
    // store initializes a profile with, or it points at nothing.
    expect(profile.temperature).toBe(DEFAULT_PROFILE_TEMPERATURE);
    expect(profile.maxOutputTokens).toBe(DEFAULT_PROFILE_MAX_OUTPUT_TOKENS);
  });
});
