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

test("a short panel keeps what fits of a notice rather than dropping it", () => {
  // The provider's reason is several rows now. On a terminal too short to
  // hold them, showing nothing would read as no error at all.
  const text = sentence(panelText(
    "Server is reachable, but the model list is unavailable.",
    10
  ));

  expect(text).toContain("Server is reachable");
});

test("a short panel keeps the final overflow instruction", () => {
  const message = `${"The provider returned a detailed connection error. ".repeat(12)}· R retries`;
  const text = sentence(panelText(message, 12));

  expect(text).toContain("esc then ! for all of it");
});

function panelText(message: string, height = 36): string {
  const source = demoAppSource();
  const state = initialState(source, false);
  state.mode = "SETTINGS";
  state.settings = initialSettingsOverlay(source.settingsView, state.config);
  state.settings.result = { state: "warning", message };
  const hitRows: HitRows = Array.from({ length: height }, () => null);
  const base: never[][] = Array.from({ length: height }, () => []);
  return frameText(renderPanels(
    base,
    state,
    hitRows,
    120,
    height,
    nextRequestEstimate(state.payload, nextRequestContext(state))
  ).lines);
}
