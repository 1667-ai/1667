/** Regression coverage for the phase 8 review-fixes brief
 * (scratchpad/spec/08-review-fixes-3.md): one Electron launch per `test()`,
 * grouping scenarios that touch the same area. Every scenario here was
 * confirmed to fail against the pre-fix code for the reason named in its
 * comment before the corresponding fix landed. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
// Playwright is supplied by the desktop release workspace.
// @ts-ignore The root backend workspace does not install the desktop lane.
import { _electron as electron, type Page } from "playwright";
import { closeDesktopApp, goToLibrary } from "./electron-test-helpers.js";

const appPath = process.env.AI_1667_DESKTOP_APP_PATH;

interface LaunchedApp {
  readonly app: import("playwright").ElectronApplication;
  readonly page: Page;
  readonly dataDir: string;
  readonly stateDir: string;
}

async function launch(): Promise<LaunchedApp> {
  if (appPath === undefined || appPath.length === 0) {
    throw new Error("AI_1667_DESKTOP_APP_PATH must point to the built Electron main entry.");
  }
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-review-fixes-3-e2e-"));
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-review-fixes-3-state-e2e-"));
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(stateDir, "browser")}`, appPath],
    env: {
      ...process.env,
      AI_1667_DESKTOP_DATA_DIR: dataDir,
      AI_1667_STATE: stateDir,
      AI_1667_NO_UPDATE_CHECK: "1"
    }
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  await page.waitForSelector(".new-story-button", { timeout: 30_000 });
  return { app, page, dataDir, stateDir };
}

async function teardown(launched: LaunchedApp): Promise<void> {
  await closeDesktopApp(launched.app);
  await rm(launched.dataDir, { recursive: true, force: true });
  await rm(launched.stateDir, { recursive: true, force: true });
}

async function createStory(page: Page, title: string): Promise<void> {
  await goToLibrary(page);
  await page.click(".new-story-button");
  await page.waitForSelector(".modal-card", { timeout: 15_000 });
  await page.fill(".modal-input", title);
  await page.click(".modal-submit");
  await page.waitForFunction((expected) => document.querySelector(".story-title")?.textContent === expected, title, { timeout: 15_000 });
}

async function saveManualPart(page: Page, text: string): Promise<void> {
  const before = await page.locator(".manuscript-part").count();
  await page.locator(".composer-input").fill(text);
  await page.locator(".composer-manual").click();
  await page.waitForFunction((expected) => document.querySelectorAll(".manuscript-part").length === expected, before + 1, { timeout: 15_000 });
}

async function focusPart(page: Page, index: number): Promise<void> {
  await page.locator(".manuscript-part").nth(index).locator(".part-prose").click();
  await page.waitForFunction(
    (expected) => document.querySelectorAll(".manuscript-part")[expected]?.classList.contains("focused") === true,
    index,
    { timeout: 15_000 }
  );
}

// Finding 3: editing a stateful Fact's only (anchored) state to story-wide
// flips the sheet from the STATES list to the simple Body editor, which must
// pick up the edited text instead of showing whatever the draft held before.
test("Electron review fixes 3: editing a Fact's only state reconciles the Body draft", { timeout: 180_000 }, async () => {
  const app = await launch();
  try {
    const page = app.page;
    await createStory(page, "Fact state reconcile proof");
    await saveManualPart(page, "The only part anchors the Fact state.");

    const part = page.locator(".manuscript-part").first();
    await part.locator(".part-prose").hover();
    await part.locator(".part-more").click();
    await page.waitForSelector(".part-menu", { timeout: 15_000 });
    await page.locator(".part-menu .part-fact-here").click();
    await page.waitForSelector(".modal-card", { timeout: 15_000 });
    await page.fill(".modal-input", "Lighthouse");
    await page.click(".modal-submit");
    await page.waitForSelector(".modal-textarea", { timeout: 15_000 });
    await page.fill(".modal-textarea", "A");
    await page.click(".modal-submit");
    await page.waitForFunction(() => document.querySelector(".toast")?.textContent?.includes("Done") === true, undefined, { timeout: 15_000 });

    await page.click(".tab-facts");
    await page.waitForSelector(".fact-card .fact-row-select", { timeout: 15_000 });
    await page.locator(".fact-card .fact-row-select").first().click();
    await page.waitForSelector(".fact-sheet .fact-state-row", { timeout: 15_000 });

    await page.locator(".fact-sheet .fact-state-edit").first().click();
    await page.waitForSelector(".modal-fields", { timeout: 15_000 });
    await page.fill("[data-dialog-field=text]", "B");
    await page.selectOption("[data-dialog-field=scope]", "Story-wide");
    await page.selectOption("[data-dialog-field=ends]", "No");
    await page.click(".modal-submit");

    // The edit turns this now-unanchored single-state Fact body-editable
    // again: the sheet must show the just-saved text, not a stale draft.
    await page.waitForSelector("[data-preserve=\"fact-editor-body\"]", { timeout: 15_000 });
    await page.waitForFunction(
      () => (document.querySelector("[data-preserve=\"fact-editor-body\"]") as HTMLTextAreaElement | null)?.value === "B",
      undefined,
      { timeout: 15_000 }
    );
    assert.equal(await page.locator(".fact-pending-bar").count(), 0, "the reconciled draft must not show as an unsaved change");
  } finally {
    await teardown(app);
  }
});

// Finding 4: a popover owns the keyboard while it is open — Enter's native
// activation of a background control that never lost focus must not reach
// it either.
test("Electron review fixes 3: Enter does not activate a manuscript control behind the keys sheet", { timeout: 180_000 }, async () => {
  const app = await launch();
  try {
    const page = app.page;
    await createStory(page, "Popover Enter containment proof");
    await saveManualPart(page, "The only part of the popover Enter story.");

    const part = page.locator(".manuscript-part").first();
    await part.locator(".part-prose").hover();
    await part.locator(".part-retake").focus();
    await page.keyboard.press("?");
    await page.waitForSelector(".keys-sheet", { timeout: 15_000 });
    await page.keyboard.press("Enter");
    const streamStarted = await page.locator(".stream-card").waitFor({ state: "visible", timeout: 1_500 }).then(() => true).catch(() => false);
    assert.equal(streamStarted, false, "Enter must not activate the retake button behind the keys sheet");
  } finally {
    await teardown(app);
  }
});

// Finding 6: after a continuation from an earlier seam lands, focus must
// move to the take it created, so the next Space continues forward instead
// of branching the same seam again.
test("Electron review fixes 3: Space twice from an earlier part advances instead of branching the same seam again", { timeout: 180_000 }, async () => {
  const app = await launch();
  try {
    const page = app.page;
    await createStory(page, "Continue advance proof");
    await saveManualPart(page, "The first part of the continue advance story.");
    await saveManualPart(page, "The second part of the continue advance story.");
    await saveManualPart(page, "The third part of the continue advance story.");

    await focusPart(page, 0);
    await page.keyboard.press("Space");
    await page.waitForSelector(".stream-card", { timeout: 30_000 });
    await page.waitForSelector(".stream-card", { state: "detached", timeout: 30_000 });
    await page.waitForFunction(() => document.querySelectorAll(".manuscript-part").length === 2, undefined, { timeout: 15_000 });
    // The take that just landed must now be focused (finding 7's own fix, in
    // this case surfaced by the same settlement rule inside `continueStory`).
    await page.waitForFunction(() => document.querySelectorAll(".manuscript-part")[1]?.classList.contains("focused") === true, undefined, { timeout: 15_000 });
    const waymarkAfterFirstSpace = await page.locator(".manuscript-part").nth(1).locator(".part-gutter-waymark").innerText();
    assert.match(waymarkAfterFirstSpace, /¶ 2 ×2/u, "¶1's seam takes on a sibling: the old ¶2 branch plus this new one");
    const textAfterFirstSpace = await page.locator(".manuscript-part").nth(1).locator(".part-prose").innerText();

    await page.keyboard.press("Space");
    await page.waitForSelector(".stream-card", { timeout: 30_000 });
    await page.waitForSelector(".stream-card", { state: "detached", timeout: 30_000 });
    await page.waitForFunction(
      (previousText) => document.querySelectorAll(".manuscript-part")[1]?.querySelector(".part-prose")?.textContent !== previousText,
      textAfterFirstSpace,
      { timeout: 15_000 }
    );

    // Without the fix, the second Space still targets ¶1 (the stale seam),
    // so it creates a *third* sibling under ¶1 and switches the path onto
    // it — ¶2 would show ×3, and its text would be a wholly new take rather
    // than the first one grown further. With the fix, focus follows the
    // landed take, so the plain (no-direction) continuation instead grows
    // this same ¶2: still exactly two siblings of ¶1, longer text, one line.
    await page.waitForFunction(() => document.querySelectorAll(".manuscript-part").length === 2, undefined, { timeout: 15_000 });
    assert.match(
      await page.locator(".manuscript-part").nth(1).locator(".part-gutter-waymark").innerText(),
      /¶ 2 ×2/u,
      "the second Space must grow the take that just landed, not branch ¶1 a second time"
    );
    const textAfterSecondSpace = await page.locator(".manuscript-part").nth(1).locator(".part-prose").innerText();
    assert.ok(textAfterSecondSpace.startsWith(textAfterFirstSpace), "growing ¶2 in place must keep its existing text as a prefix");
    assert.ok(textAfterSecondSpace.length > textAfterFirstSpace.length, "the second Space must add to ¶2's text");
  } finally {
    await teardown(app);
  }
});

// Finding 7: "Write from here" must move focus to the part it targeted, not
// leave it on whatever was focused before opening the menu.
test("Electron review fixes 3: Write from here moves focus to its target part", { timeout: 180_000 }, async () => {
  const app = await launch();
  try {
    const page = app.page;
    await createStory(page, "Write from here focus proof");
    await saveManualPart(page, "The first part of the write from here story.");
    await saveManualPart(page, "The second part of the write from here story.");

    await focusPart(page, 0);
    const second = page.locator(".manuscript-part").nth(1);
    await second.locator(".part-prose").hover();
    await second.locator(".part-more").click();
    await page.waitForSelector(".part-menu", { timeout: 15_000 });
    await page.locator(".part-menu .part-switch").click();
    await page.waitForFunction(() => document.querySelectorAll(".manuscript-part")[1]?.classList.contains("focused") === true, undefined, { timeout: 15_000 });
  } finally {
    await teardown(app);
  }
});
