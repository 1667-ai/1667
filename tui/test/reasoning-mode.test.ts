import { describe, expect, test } from "bun:test";
import { initialState } from "../src/app.js";
import { demoAppSource } from "../src/demo.js";
import { publishSettingsView } from "../src/overlay-publication.js";

/**
 * `state.reasoning` is populated the same way `state.model` is —
 * `deriveContinuationRuntime` (runtime-settings.ts), reached through
 * `initialState` at startup and `publishSettingsView` on every settings
 * republish. This exercises that wiring end to end, the same boundary
 * `test/settings-save.test.ts` already drives `publishSettingsView` through,
 * rather than only setting `state.reasoning` directly the way the rendering
 * tests (reasoning-story-render.test.ts) do.
 */
describe("reasoning mode reaches the story screen", () => {
  test("a saved profile's reasoning field republishes onto state.reasoning", () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    expect(state.reasoning).toBe("marker");

    const view = source.settingsView;
    if (!view.editable) throw new Error("demo settings must be editable");
    const document = {
      ...view.document,
      profiles: {
        ...view.document.profiles,
        default: { ...view.document.profiles.default!, reasoning: "open" as const }
      }
    };
    publishSettingsView(state, source, {
      ...view,
      document,
      effectiveProseReasoning: "open"
    });
    expect(state.reasoning).toBe("open");

    // A republish that never sends the field at all — an older server
    // response, or any other fixture built without it — falls back to
    // `marker`, the same default an absent profile field resolves to
    // everywhere else, rather than leaving the previous value stuck.
    const { effectiveProseReasoning: _dropped, ...withoutField } = {
      ...view,
      document,
      effectiveProseReasoning: "open" as const
    };
    publishSettingsView(state, source, withoutField as typeof view);
    expect(state.reasoning).toBe("marker");
  });

  test("off suppresses reasoning the same way", () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const view = source.settingsView;
    if (!view.editable) throw new Error("demo settings must be editable");
    publishSettingsView(state, source, { ...view, effectiveProseReasoning: "off" });
    expect(state.reasoning).toBe("off");
  });

  test("uses the server-resolved active prompt layout, not the pending document", () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const view = source.settingsView;
    if (!view.editable) throw new Error("editable settings missing");
    const pendingDocument = {
      ...view.document,
      profiles: {
        ...view.document.profiles,
        default: {
          ...view.document.profiles.default!,
          continuationPromptOptimization: "late-cache-stable" as const
        }
      }
    };
    publishSettingsView(state, source, {
      ...view,
      document: pendingDocument,
      effectiveProseContinuationPromptLayout: "compatibility"
    });
    expect(state.continuationPromptLayout).toBe("compatibility");

    publishSettingsView(state, source, {
      ...view,
      document: pendingDocument,
      effectiveProseContinuationPromptLayout: "late-cache-stable"
    });
    expect(state.continuationPromptLayout).toBe("late-cache-stable");
  });
});
