import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
// Playwright is supplied by the desktop release workspace.
// @ts-ignore The root backend workspace does not install the desktop lane.
import { _electron as electron } from "playwright";
import { closeDesktopApp, createStory, retakeSecondPart, saveManualPart, switchTakeGaugeDot } from "./electron-test-helpers.js";

const appPath = process.env.AI_1667_DESKTOP_APP_PATH;

test("Electron Compare: ⌥-click compares an off-path take with your line", { timeout: 180_000 }, async () => {
  assert.ok(appPath, "AI_1667_DESKTOP_APP_PATH must point to the built Electron main entry.");
  const directory = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-compare-e2e-"));
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
    await createStory(page, "Compare story");
    await saveManualPart(page, "First part of the compare story.");
    await saveManualPart(page, "Second part, first take.");

    // Two takes at ¶ 2: retake it (making take 2 the current one), read its
    // text off the manuscript before switching back to take 1 — that leaves
    // take 2 off the current line, which is what this test compares.
    await retakeSecondPart(page);
    const take2Text = (await page.locator(".manuscript-part").nth(1).locator(".part-prose").textContent())?.trim() ?? "";
    assert.ok(take2Text.length > 0, "the retaken part must have text to compare against");
    await switchTakeGaugeDot(page, 0, "take 1/2");

    await page.locator(".tab-map").click();
    await page.waitForSelector("svg.stemma", { timeout: 15_000 });
    const offPathNode = page.locator("svg.stemma circle.map-node.off-path").first();
    await offPathNode.waitFor({ state: "visible", timeout: 15_000 });
    await offPathNode.click({ modifiers: ["Alt"] });

    const popover = page.locator(".compare-popover");
    await popover.waitFor({ state: "visible", timeout: 15_000 });
    // The popover opens with a loading title and fills in when the read
    // returns; wait for the read, not only for the popover.
    await page.waitForFunction(() => document.querySelector(".compare-popover .compare-columns") !== null, undefined, { timeout: 15_000 });
    assert.ok((await popover.locator(".popover-title").textContent())?.includes("¶ 2"), "heading names the take's part number");
    const sharedText = await popover.locator(".compare-shared").textContent();
    assert.ok(sharedText?.includes("First part of the compare story."), "shared tail shows ¶ 1's text");
    const yourColumnText = await popover.locator(".compare-column").nth(0).textContent();
    assert.ok(yourColumnText?.includes("Second part, first take."), "Your line column shows take 1's text");
    const takeColumnText = await popover.locator(".compare-column").nth(1).textContent();
    assert.ok(takeColumnText?.includes(take2Text), "This take column shows take 2's text");

    await page.keyboard.press("Escape");
    await popover.waitFor({ state: "detached", timeout: 15_000 });

    // Escape only closed the popover — Map does not carry the breadcrumb's
    // take count, so confirm the line held by reading it on Write.
    await page.locator(".tab-write").click();
    await page.waitForSelector(".tab-content.write", { timeout: 15_000 });
    await page.waitForFunction(() => document.querySelector(".breadcrumb")?.textContent?.includes("take 1 of 2") === true, undefined, { timeout: 15_000 });

    await page.locator(".manuscript-part").nth(1).locator(".part-prose").click();
    await page.waitForFunction(() => document.querySelectorAll(".manuscript-part")[1]?.classList.contains("focused") === true, undefined, { timeout: 15_000 });
    const offTakeRow = page.locator(".inspector .take-row:not(.shown)");
    await offTakeRow.waitFor({ state: "visible", timeout: 15_000 });
    await offTakeRow.click({ modifiers: ["Alt"] });
    await popover.waitFor({ state: "visible", timeout: 15_000 });
    await popover.locator(".compare-show").click();
    await page.waitForFunction(() => document.querySelector(".breadcrumb")?.textContent?.includes("take 2 of 2") === true, undefined, { timeout: 15_000 });
    assert.equal(await page.locator(".compare-popover").count(), 0, "Show this take closes the popover");
  } finally {
    await closeDesktopApp(app);
    await rm(directory, { recursive: true, force: true });
  }
});
