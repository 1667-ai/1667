import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
// Playwright is supplied by the desktop release workspace.
// @ts-ignore The root backend workspace does not install the desktop lane.
import { _electron as electron } from "playwright";
import { closeDesktopApp, createStory, saveManualPart } from "./electron-test-helpers.js";

const appPath = process.env.AI_1667_DESKTOP_APP_PATH;
const shortcut = process.platform === "darwin" ? "Meta" : "Control";

interface Box { readonly left: number; readonly top: number; readonly width: number; readonly height: number }

test("Electron Map: the minimap drags the stage, keeps scroll across an unrelated re-render, and steps with the arrow keys", { timeout: 180_000 }, async () => {
  assert.ok(appPath, "AI_1667_DESKTOP_APP_PATH must point to the built Electron main entry.");
  const directory = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-map-minimap-e2e-"));
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
    await createStory(page, "Minimap story");

    // A short first part (so centering it later clamps the stage to
    // scrollLeft 0, regardless of the panel's exact width) plus enough short
    // ones that the spine still overflows the stage. R-17 scales the spine
    // to the pane and clamps every gap to at most 120px, so a handful of
    // long parts no longer forces horizontal scroll the way it used to —
    // only the part count reliably does, at the 48px minimum gap, 34 gaps
    // is 1 632px, comfortably past `main.ts`'s 1280px default window.
    await saveManualPart(page, "Start.");
    for (let index = 1; index < 35; index += 1) await saveManualPart(page, `Part ${index}.`);

    // Focus the first part before entering Map, so entering centres the
    // stage near the start of the line instead of the leaf at the far end —
    // the drag-right assertion below needs room to move.
    await page.locator(".manuscript-part").first().locator(".part-prose").click();
    await page.waitForFunction(() => document.querySelectorAll(".manuscript-part")[0]?.classList.contains("focused") === true, undefined, { timeout: 15_000 });

    await page.locator(".tab-map").click();
    await page.waitForSelector("svg.stemma", { timeout: 15_000 });
    await page.waitForSelector(".map-minimap-viewport", { timeout: 15_000 });

    const initial = await page.evaluate(() => {
      const strip = document.querySelector(".map-minimap-strip")?.getBoundingClientRect() ?? null;
      const rect = document.querySelector(".map-minimap-viewport")?.getBoundingClientRect() ?? null;
      const stage = document.querySelector(".map-stage") as HTMLElement | null;
      return {
        strip: strip === null ? null : { left: strip.left, top: strip.top, width: strip.width, height: strip.height },
        rect: rect === null ? null : { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        scrollLeft: stage?.scrollLeft ?? 0,
        scrollWidth: stage?.scrollWidth ?? 0,
        clientWidth: stage?.clientWidth ?? 0
      };
    });
    assert.ok(initial.strip !== null, "the minimap strip must render for this story");
    assert.ok(initial.rect !== null, "the minimap viewport rectangle must render");
    const strip = initial.strip as Box;
    const rect = initial.rect as Box;
    assert.ok(rect.width < strip.width, `expected the viewport rectangle (${rect.width}px) narrower than the strip (${strip.width}px)`);
    assert.ok(initial.scrollWidth > initial.clientWidth, "the stage must actually overflow for this fixture");

    // 1. Drag the rectangle to the right end of the strip.
    await page.mouse.move(rect.left + rect.width / 2, rect.top + rect.height / 2);
    await page.mouse.down();
    await page.mouse.move(strip.left + strip.width - 4, rect.top + rect.height / 2, { steps: 12 });
    await page.mouse.up();

    const afterDrag = await page.evaluate(() => ({
      left: document.querySelector(".map-minimap-viewport")?.getBoundingClientRect().left ?? 0,
      scrollLeft: (document.querySelector(".map-stage") as HTMLElement | null)?.scrollLeft ?? 0
    }));
    assert.ok(afterDrag.scrollLeft > initial.scrollLeft, `expected scrollLeft to increase from ${initial.scrollLeft}, got ${afterDrag.scrollLeft}`);
    assert.ok(afterDrag.left > rect.left, `expected the rectangle to move right from ${rect.left}, got ${afterDrag.left}`);

    // 2. An unrelated re-render (opening and closing the command palette)
    // must not reset the stage's horizontal scroll.
    await page.keyboard.press(`${shortcut}+k`);
    await page.waitForSelector(".palette", { timeout: 15_000 });
    await page.keyboard.press("Escape");
    await page.waitForSelector(".palette", { state: "detached", timeout: 15_000 });
    const afterPalette = await page.evaluate(() => (document.querySelector(".map-stage") as HTMLElement | null)?.scrollLeft ?? 0);
    assert.equal(afterPalette, afterDrag.scrollLeft, "an unrelated re-render must not move the stage's scroll");

    // 3. Focus the rectangle and walk it back to the start with ArrowLeft.
    await page.locator(".map-minimap-viewport").focus();
    let previous = -1;
    let current = afterPalette;
    for (let attempt = 0; current !== previous && attempt < 40; attempt += 1) {
      previous = current;
      await page.keyboard.press("ArrowLeft");
      current = await page.evaluate(() => (document.querySelector(".map-stage") as HTMLElement | null)?.scrollLeft ?? 0);
    }
    assert.equal(current, 0, "ArrowLeft must walk the viewport back to the start of the line");
  } finally {
    await closeDesktopApp(app);
    await rm(directory, { recursive: true, force: true });
  }
});
