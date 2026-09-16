import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
// Playwright is supplied by the desktop release workspace.
// @ts-ignore The root backend workspace does not install the desktop lane.
import { _electron as electron, type Page } from "playwright";
import { closeDesktopApp, goToLibrary } from "./electron-test-helpers.js";

const appPath = process.env.AI_1667_DESKTOP_APP_PATH;

test("Electron Aside popover and the log", { timeout: 120_000 }, async () => {
  assert.ok(appPath, "AI_1667_DESKTOP_APP_PATH must point to the built Electron main entry.");
  const directory = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-aside-popover-e2e-"));
  const dataDir = path.join(directory, "project");
  await mkdir(dataDir, { mode: 0o700 });
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(directory, "browser")}`, appPath],
    env: {
      ...process.env,
      AI_1667_STATE: path.join(directory, "machine"),
      AI_1667_DESKTOP_DATA_DIR: dataDir,
      AI_1667_NO_UPDATE_CHECK: "1"
    }
  });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector(".new-story-button", { timeout: 30_000 });
    await createStory(page, "Aside popover story");
    await page.locator(".composer-input").fill("The only part anchors the Aside session.");
    await page.locator(".composer-manual").click();
    await page.waitForSelector(".manuscript-part", { timeout: 15_000 });
    await page.waitForSelector(".aside-session-picker", { timeout: 15_000 });

    const question = "What is under the lamp?";
    await page.fill(".aside-question", question);
    await page.click(".aside-ask");
    await page.waitForFunction(
      (expected) => [...document.querySelectorAll(".aside-turn")].some((turn) =>
        turn.querySelector(".aside-question-line")?.textContent === expected
        && (turn.querySelector(".aside-answer")?.textContent?.length ?? 0) > 0),
      question,
      { timeout: 30_000 }
    );

    await page.locator(".aside-popout").click();
    await page.waitForSelector(".aside-popover", { timeout: 15_000 });
    await page.waitForSelector(".hop-strip", { timeout: 15_000 });
    const hopText = await page.locator(".hop-strip").innerText();
    // The ask response's own `asidePresence` (`shared/aside-session-index.ts`)
    // carries session counts only, not the display ordinals a dedicated
    // `getAsideV2` read computes (`server/aside-session-read.ts`) — a
    // pre-existing gap, not a phase 5 regression — so the part number can
    // read "?" here. What phase 5 owns is that the hop strip brackets the
    // current entry in the `[ ¶ … ]`-style D-27 gives it.
    assert.match(hopText, /\[\s*¶\s*(?:\d+|\?)/u, `expected a bracketed "[ ¶ … ]" current hop entry, got: ${hopText}`);
    assert.match(await page.locator(".aside-popover .aside-turns").innerText(), new RegExp(question.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));

    await page.keyboard.press("Escape");
    await page.waitForSelector(".aside-popover", { state: "detached", timeout: 15_000 });

    await page.keyboard.press("!");
    await page.waitForSelector(".popover.log", { timeout: 15_000 });
    assert.match(await page.locator(".log-list").innerText(), /Aside saved/u);
    await page.keyboard.press("Escape");
    await page.waitForSelector(".popover.log", { state: "detached", timeout: 15_000 });
  } finally {
    await closeDesktopApp(app);
    await rm(directory, { recursive: true, force: true });
  }
});

async function createStory(page: Page, title: string): Promise<void> {
  await goToLibrary(page);
  await page.locator(".new-story-button").click();
  await page.waitForSelector(".modal-card", { timeout: 15_000 });
  await page.locator(".modal-input").fill(title);
  await page.locator(".modal-submit").click();
  await page.waitForFunction((expected) => document.querySelector(".story-title")?.textContent === expected, title, { timeout: 15_000 });
}
