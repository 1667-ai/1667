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

test("Electron retains nonfirst item focus across activation and dialogs", { timeout: 120_000 }, async () => {
  assert.ok(appPath, "AI_1667_DESKTOP_APP_PATH must point to the built Electron main entry.");
  const directory = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-focus-e2e-"));
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
    page.setDefaultTimeout(15_000);
    await page.waitForSelector(".new-story-button", { timeout: 30_000 });
    await createStory(page, "Focus first");
    await createStory(page, "Focus second");
    await createStory(page, "Focus third");

    await goToLibrary(page);
    await page.locator(".project-browser").click();
    await page.waitForSelector(".launcher-page", { timeout: 15_000 });
    const channel = page.locator(".updater-channel");
    await channel.focus();
    await channel.selectOption("beta");
    await page.waitForFunction(
      () => document.querySelector(".updater-message")?.textContent?.includes("beta desktop update") === true,
      undefined,
      { timeout: 30_000 }
    );
    assert.equal(await page.locator(":focus").getAttribute("data-preserve"), "updater-channel");
    await page.getByRole("button", { name: "Back to story" }).click();
    await waitForStory(page, "Focus third");

    // Selecting a story switches Library away for Write, so the row itself
    // is gone once the switch lands; focus should move to the new
    // destination's entry point instead of dropping to the document body.
    const secondStory = page.locator(".story-row").filter({ hasText: "Focus second" });
    await secondStory.focus();
    await secondStory.press("Enter");
    await waitForStory(page, "Focus second");
    await page.waitForFunction(() => document.activeElement?.classList.contains("tab-write") === true, undefined, { timeout: 15_000 });
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("active")), true);

    await goToLibrary(page);
    await secondStory.focus();
    await secondStory.press("Enter");
    await waitForStory(page, "Focus second");
    await page.waitForFunction(() => document.activeElement?.classList.contains("tab-write") === true, undefined, { timeout: 15_000 });
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("active")), true);

    await page.locator(".composer-input").fill("A passage for the focus proof.");
    await page.locator(".composer-manual").click();
    await page.waitForSelector(".manuscript-part", { timeout: 15_000 });
    const firstQuestion = "Which focus survives the first question?";
    await askAside(page, firstQuestion);
    const secondQuestion = "Which focus survives the second question?";
    await askAside(page, secondQuestion);
    const secondDelete = page.locator(".aside-turn").nth(1).locator(".aside-delete-turn");
    await secondDelete.focus();
    await secondDelete.press("Enter");
    const dialog = page.locator('.modal-card[aria-label="Delete Aside turn"]');
    await dialog.waitFor({ state: "visible", timeout: 15_000 });
    await dialog.locator(".modal-cancel").click();
    await page.waitForFunction((expected) => {
      const focused = document.activeElement;
      return focused?.classList.contains("aside-delete-turn")
        && focused.closest(".aside-turn")?.querySelector(".aside-question-line")?.textContent === expected;
    }, secondQuestion, { timeout: 15_000 });
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
  await waitForStory(page, title);
}

async function waitForStory(page: Page, title: string): Promise<void> {
  await page.waitForFunction((expected) => document.querySelector(".story-title")?.textContent === expected, title, { timeout: 30_000 });
}

async function askAside(page: Page, question: string): Promise<void> {
  await page.locator(".aside-question").fill(question);
  await page.locator(".aside-ask").click();
  await page.waitForSelector(".aside-stop", { timeout: 15_000 });
  await page.waitForSelector(".aside-stop", { state: "detached", timeout: 30_000 });
  await page.waitForFunction((expected) => [...document.querySelectorAll(".aside-turn")]
    .some((turn) => turn.querySelector(".aside-question-line")?.textContent === expected), question, { timeout: 30_000 });
}
