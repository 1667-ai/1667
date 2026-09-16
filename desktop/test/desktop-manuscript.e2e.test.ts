import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
// Playwright is supplied by the desktop release workspace.
// @ts-ignore The root backend workspace does not install the desktop lane.
import { _electron as electron, type Page } from "playwright";
import { closeDesktopApp, editPart, goToLibrary } from "./electron-test-helpers.js";

const appPath = process.env.AI_1667_DESKTOP_APP_PATH;
const shortcut = process.platform === "darwin" ? "Meta" : "Control";

test("Electron manuscript: focus vs edit, the toolbar, the take gauge, and the composer states", { timeout: 180_000 }, async () => {
  if (appPath === undefined || appPath.length === 0) {
    throw new Error("AI_1667_DESKTOP_APP_PATH must point to the built Electron main entry.");
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-manuscript-e2e-"));
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
    await createStory(page, "Manuscript story");
    await saveManualPart(page, "The first part of the manuscript story.");
    await saveManualPart(page, "The second part of the manuscript story.");

    await testFocusVsEdit(page);
    await testHoverToolbarAndMenu(page);
    await testRetakeAndGauge(page);
    await testComposerStates(page);
    await testDirectionsToggle(page);
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

async function saveManualPart(page: Page, text: string): Promise<void> {
  const before = await page.locator(".manuscript-part").count();
  await page.locator(".composer-input").fill(text);
  await page.locator(".composer-manual").click();
  await page.waitForFunction((expected) => document.querySelectorAll(".manuscript-part").length === expected, before + 1, { timeout: 15_000 });
}

// 1. After two manual parts, no `.part-text` exists at rest; `.part-prose`
// shows the text; the second part is `.focused` and its gutter reads `¶ 2`;
// the first is `.dim`. Double-click part 1 -> edit; escape -> draft kept.
async function testFocusVsEdit(page: Page): Promise<void> {
  assert.equal(await page.locator(".part-text").count(), 0, "no part-text exists at rest");
  const first = page.locator(".manuscript-part").nth(0);
  const second = page.locator(".manuscript-part").nth(1);
  assert.match(await first.locator(".part-prose").innerText(), /The first part/u);
  assert.equal(await second.evaluate((el) => el.classList.contains("focused")), true, "the last part starts focused");
  assert.equal(await first.evaluate((el) => el.classList.contains("dim")), true, "an unfocused part is dim");
  assert.match(await second.locator(".part-gutter-waymark").innerText(), /¶ 2/u);

  const text = await editPart(page, 0);
  await text.fill("The first part of the manuscript story, revised.");
  await page.keyboard.press("Escape");
  await page.waitForSelector(".part-text", { state: "detached", timeout: 15_000 });
  assert.match(await first.locator(".part-prose").innerText(), /revised/u, "esc keeps the draft in the prose");
  assert.equal(await first.locator(".part-gutter-dirty").isHidden(), false, "the dirty waymark shows for an unsaved draft");

  await first.locator(".part-prose").dblclick();
  await page.waitForSelector(".part-text", { timeout: 15_000 });
  const shortcutKey = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${shortcutKey}+s`);
  await page.waitForFunction(() => document.querySelector(".toast")?.textContent?.includes("Saved") === true, undefined, { timeout: 15_000 });
  await page.waitForSelector(".part-text", { state: "detached", timeout: 15_000 });
  // The saved text is now a human span (D-09): the ✎ waymark stays, but for
  // a different, permanent reason — it survives the save on purpose.
  assert.equal(await first.evaluate((el) => el.classList.contains("human")), true, "an edited part becomes a human span");
  assert.equal(await first.locator(".part-gutter-dirty").isHidden(), false, "the ✎ waymark still marks the human span");
  assert.match(await first.locator(".part-prose").innerText(), /revised/u);
}

// 2. Hover part 1 -> `.part-toolbar` is visible and Retake mentions `r`;
// `···` lists Summary take and Delete part.
async function testHoverToolbarAndMenu(page: Page): Promise<void> {
  const first = page.locator(".manuscript-part").nth(0);
  await first.locator(".part-prose").hover();
  await page.waitForSelector(".manuscript-part >> nth=0 >> .part-toolbar", { timeout: 15_000 });
  const retake = first.locator(".part-retake");
  await retake.waitFor({ state: "visible", timeout: 15_000 });
  assert.match(await retake.innerText(), /r/iu);

  await first.locator(".part-more").click();
  await page.waitForSelector(".part-menu", { timeout: 15_000 });
  const menuText = await page.locator(".part-menu-list").innerText();
  assert.match(menuText, /Summary take/u);
  assert.match(menuText, /Delete part/u);
  await page.keyboard.press("Escape");
  await page.waitForSelector(".part-menu", { state: "detached", timeout: 15_000 });
}

// 3. Retake (click `.part-retake`) -> the part's gutter shows `×2`, the
// `.take-gauge` has 2 dots, `‹ take 2/2 ›`; click the first dot -> `take
// 1/2` and a toast `take 1 of 2`.
async function testRetakeAndGauge(page: Page): Promise<void> {
  const first = page.locator(".manuscript-part").nth(0);
  await first.locator(".part-prose").click();
  await page.waitForFunction(() => document.querySelectorAll(".manuscript-part")[0]?.classList.contains("focused") === true, undefined, { timeout: 15_000 });
  await first.locator(".part-prose").hover();
  await first.locator(".part-retake").click();
  await page.waitForSelector(".stream-card", { timeout: 30_000 });
  await page.waitForSelector(".stream-card", { state: "detached", timeout: 30_000 });

  const retaken = page.locator(".manuscript-part.focused");
  await page.waitForFunction(() => document.querySelector(".manuscript-part.focused .part-gutter-waymark")?.textContent?.includes("×2") === true, undefined, { timeout: 15_000 });
  assert.match(await retaken.locator(".part-gutter-waymark").innerText(), /×2/u);
  assert.equal(await retaken.locator(".take-gauge-dot").count(), 2, "the gauge has 2 dots for 2 takes");
  assert.match(await retaken.locator(".part-take-count").innerText(), /take 2\/2/u);

  await retaken.locator(".take-gauge-dot").first().click();
  await page.waitForFunction(() => document.querySelector(".manuscript-part.focused .part-take-count")?.textContent?.includes("take 1/2") === true, undefined, { timeout: 15_000 });
  // The toast settles a render or two after the take switch itself (the
  // switch's own status write follows `replaceStory`'s); wait on the toast
  // directly rather than racing it against the take-count update above.
  await page.waitForFunction(() => document.querySelector(".toast")?.textContent?.includes("take 1 of 2") === true, undefined, { timeout: 15_000 });
  assert.match(await page.locator(".toast").innerText(), /take 1 of 2/u);
}

// 4. Composer: rest hint reads `Empty ↵ continues`; typing shows the
// `CONTINUE ·` eyebrow; the direct mode button shows `DIRECT ·`; ⌘/Ctrl+Enter
// sends and the streaming part shows a caret; Escape stops it.
async function testComposerStates(page: Page): Promise<void> {
  const placeholder = await page.locator(".composer-input").getAttribute("placeholder");
  assert.match(placeholder ?? "", /Empty ↵ continues/u);
  const input = page.locator(".composer-input");
  await input.click();
  await input.fill("A new direction for the next part.");
  await page.waitForFunction(() => document.querySelector(".composer-eyebrow")?.textContent?.includes("CONTINUE") === true, undefined, { timeout: 15_000 });
  await page.locator(".composer-mode-direct").click();
  await page.waitForFunction(() => document.querySelector(".composer-eyebrow")?.textContent?.includes("DIRECT") === true, undefined, { timeout: 15_000 });

  await input.press(`${shortcut}+Enter`);
  await page.waitForSelector(".manuscript-part.streaming", { timeout: 30_000 });
  await page.waitForSelector(".manuscript-part.streaming .caret", { timeout: 15_000 });
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () => document.querySelector(".manuscript-part.streaming") === null || document.querySelector(".stopped-generation") !== null,
    undefined,
    { timeout: 30_000 }
  );
}

// 5. `p` hides and shows `.part-instruction`.
async function testDirectionsToggle(page: Page): Promise<void> {
  if (await page.locator(".stopped-generation").count() > 0) await page.locator(".stopped-discard, .stopped-save").first().click();
  await page.waitForFunction(() => document.querySelector(".stream-card, .stopped-generation") === null, undefined, { timeout: 15_000 });

  const first = page.locator(".manuscript-part").nth(0);
  await editPart(page, 0);
  await first.locator(".part-edit-direction").click();
  const dialog = page.locator('.modal-card[aria-label="Edit direction"]');
  await dialog.waitFor({ state: "visible", timeout: 15_000 });
  await dialog.locator(".modal-input").fill("A quiet direction for part one.");
  await dialog.locator(".modal-submit").click();
  await page.waitForFunction(() => document.querySelector(".part-instruction")?.textContent === "A quiet direction for part one.", undefined, { timeout: 15_000 });
  await page.keyboard.press("Escape");
  await page.waitForSelector(".part-text", { state: "detached", timeout: 15_000 });

  await first.locator(".part-instruction").waitFor({ state: "visible", timeout: 15_000 });
  await page.keyboard.press("p");
  await first.locator(".part-instruction").waitFor({ state: "hidden", timeout: 15_000 });
  await page.keyboard.press("p");
  await first.locator(".part-instruction").waitFor({ state: "visible", timeout: 15_000 });
}
