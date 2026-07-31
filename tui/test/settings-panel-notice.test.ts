import { expect, test } from "bun:test";
import { renderPanels } from "../src/screens/panels.js";
import { initialState } from "../src/app.js";
import { demoAppSource } from "../src/demo.js";
import { initialSettingsOverlay } from "../src/settings-overlay-model.js";
import { frameText } from "../src/screens/story/frame.js";
import { nextRequestEstimate } from "../src/request-projection.js";
import { nextRequestContext } from "../src/request-context.js";
import type { HitRows } from "../src/hit.js";

/** A provider says whatever it likes. The panel has to show all of it. */
test("a long provider notice wraps instead of losing the reason", () => {
  const message = "Server is reachable, but /v1/models/claude-sonnet-4-5-20250929 "
    + "returned 404, so the model list is unavailable.";
  // Every word survives, in order, once the frame and the wrap are undone.
  expect(sentence(panelText(message))).toContain(message);
});

test("an oversized token is continued, not silently shortened", () => {
  // One token far wider than the panel: no spaces to break on.
  const token = "abcdefghij".repeat(12);
  // Each wrapped chunk used to advance one cell further than it drew, so a
  // character vanished at every boundary.
  expect(dense(panelText(`404 on ${token}`))).toContain(token);
});

/** The panel's own frame is not part of the notice. */
function withoutFrame(text: string): string {
  return text.replace(/[\u250f\u2513\u2517\u251b\u2501\u2503\u25b8\u25b2\u2713]/gu, " ");
}

function sentence(text: string): string {
  return withoutFrame(text).replace(/\s+/gu, " ");
}

function dense(text: string): string {
  return withoutFrame(text).replace(/\s+/gu, "");
}

function panelText(message: string): string {
  const source = demoAppSource();
  const state = initialState(source, false);
  state.mode = "SETTINGS";
  state.settings = initialSettingsOverlay(source.settingsView, state.config);
  state.settings.result = { state: "warning", message };
  const hitRows: HitRows = Array.from({ length: 36 }, () => null);
  const base: never[][] = Array.from({ length: 36 }, () => []);
  return frameText(renderPanels(
    base,
    state,
    hitRows,
    120,
    36,
    nextRequestEstimate(state.payload, nextRequestContext(state))
  ).lines);
}
