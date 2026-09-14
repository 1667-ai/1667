export * from "../../client/demo.js";
import type { AppSource } from "./app.js";
import { NEW_INSTALL_THEME, normalizeUserConfig } from "./config.js";
import { createDemoController, demoStoryApi, DEMO_SETTINGS_VIEW } from "../../client/demo.js";

/** TUI-only renderer wiring for the renderer-neutral demo adapter. */
export function demoAppSource(dense = false): AppSource {
  const demo = createDemoController(dense);
  const settingsView = structuredClone(DEMO_SETTINGS_VIEW);
  return {
    payload: demo.payload(),
    api: demoStoryApi(demo),
    demo: true,
    stories: demo.listStories(),
    settingsView,
    settings: settingsView.effective,
    storyFolder: "",
    exportDirectory: process.cwd(),
    connection: null,
    searchDebounceMs: 0,
    contextProbeDebounceMs: 0,
    config: normalizeUserConfig({
      theme: NEW_INSTALL_THEME,
      updates: { mode: "notify" }
    }),
    readingPositions: {}
  };
}
