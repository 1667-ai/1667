import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
// Playwright is supplied by the desktop release workspace.
// @ts-ignore The root backend workspace does not install the desktop lane.
import { _electron as electron, type Page } from "playwright";
import { closeDesktopApp, createStory, retakeSecondPart, saveManualPart, switchTakeGaugeDot } from "./electron-test-helpers.js";

const appPath = process.env.AI_1667_DESKTOP_APP_PATH;

test("Electron Map: the fisheye lens opens a hovered run and collapses it again", { timeout: 180_000 }, async () => {
  assert.ok(appPath, "AI_1667_DESKTOP_APP_PATH must point to the built Electron main entry.");
  const directory = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-map-lens-e2e-"));
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
    await createStory(page, "Lens story");
    await saveManualPart(page, "First part of the lens story.");
    await saveManualPart(page, "Second part, first take.");

    // Retake ¶ 2, write a manual ¶ 3 under the retake (so the off-path
    // subtree has 2 takes in it — a run, not a single node), then switch
    // back to the first take so the retake's whole subtree goes off-path.
    await retakeSecondPart(page);
    await saveManualPart(page, "Third part, under the retake.");

    // Writing ¶ 3 moved focus there — refocus ¶ 2 (the fork) before reading
    // its take gauge.
    await page.locator(".manuscript-part").nth(1).locator(".part-prose").click();
    await page.waitForFunction(() => document.querySelectorAll(".manuscript-part")[1]?.classList.contains("focused") === true, undefined, { timeout: 15_000 });
    await switchTakeGaugeDot(page, 0, "take 1/2");

    await page.locator(".tab-map").click();
    await page.waitForSelector("svg.stemma", { timeout: 15_000 });

    const before = await page.evaluate(() => ({
      runs: document.querySelectorAll(".map-collapsed-run").length,
      offPath: document.querySelectorAll("circle.map-node.off-path").length
    }));
    assert.equal(before.runs, 1, "the retake's 2-take subtree starts collapsed to one run");
    assert.equal(before.offPath, 0, "nothing off-path is drawn individually before the lens opens it");

    // The fork sits on ¶ 1 (the retake's parent) — the first on-path circle
    // in document order.
    const forkBox = await page.evaluate(() => {
      const circle = document.querySelectorAll("circle.map-node.on-path")[0] as SVGCircleElement;
      const rect = circle.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await hoverUntilLens(page, forkBox);

    const opened = await page.evaluate(() => ({
      runs: document.querySelectorAll(".map-collapsed-run").length,
      offPath: document.querySelectorAll("circle.map-node.off-path").length
    }));
    assert.equal(opened.runs, before.runs - 1, "the run bar for the hovered subtree is gone");
    assert.equal(opened.offPath, before.offPath + 2, "both takes of the opened subtree are now drawn individually");

    // Move the pointer off the stage entirely (the titlebar, well above and
    // left of it) — the run collapses again.
    await page.mouse.move(10, 10);
    await page.waitForSelector("rect.map-lens", { state: "detached", timeout: 15_000 });

    const closed = await page.evaluate(() => ({
      runs: document.querySelectorAll(".map-collapsed-run").length,
      offPath: document.querySelectorAll("circle.map-node.off-path").length
    }));
    assert.equal(closed.runs, before.runs, "the subtree collapses back to one run once the pointer leaves");
    assert.equal(closed.offPath, before.offPath, "the opened nodes are gone once the pointer leaves");

    // Hover again and click the opened branch root — it should focus that
    // take (the retake, "take 2 of 2" at ¶ 2).
    // A full re-render closes the hover lens until the pointer moves again,
    // which would hide the opened node before the click lands; retry.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await hoverUntilLens(page, forkBox);
      const clicked = await page.locator("circle.map-node.off-path").first().click({ timeout: 3_000 }).then(() => true, () => false);
      if (clicked) break;
    }
    await page.waitForFunction(() => document.querySelector(".toast")?.textContent?.includes("take 2 of 2") === true, undefined, { timeout: 15_000 });
  } finally {
    await closeDesktopApp(app);
    await rm(directory, { recursive: true, force: true });
  }
});

/** Hover `point` until the lens is open with the run expanded. A full
 * re-render closes a hover lens until the next pointer move, so nudge the
 * pointer and check again instead of waiting on one move. */
async function hoverUntilLens(page: Page, point: { readonly x: number; readonly y: number }): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await page.mouse.move(point.x + (attempt % 2), point.y);
    const open = await page.waitForFunction(
      () => document.querySelector("rect.map-lens") !== null && document.querySelectorAll("circle.map-node.off-path").length > 0,
      undefined,
      { timeout: 3_000 }
    ).then(() => true, () => false);
    if (open) return;
  }
  throw new Error("The map lens did not open under the pointer.");
}
