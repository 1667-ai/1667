/** Regression coverage for the phase 7 review-fixes brief
 * (scratchpad/spec/07-review-fixes-2.md): one Electron launch per `test()`,
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
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-review-fixes-2-e2e-"));
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-review-fixes-2-state-e2e-"));
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

async function retakePart(page: Page, index: number): Promise<void> {
  const part = page.locator(".manuscript-part").nth(index);
  await part.locator(".part-prose").hover();
  await part.locator(".part-retake").click();
  await page.waitForSelector(".stream-card", { timeout: 30_000 });
  await page.waitForSelector(".stream-card", { state: "detached", timeout: 30_000 });
}

// Finding 1: Space (Continue) from an earlier focused part must target that
// part, not extend whatever the leaf currently is.
test("Electron review fixes 2: Continue from a focused seam targets that part, not the leaf", { timeout: 180_000 }, async () => {
  const app = await launch();
  try {
    const page = app.page;
    await createStory(page, "Continue seam proof");
    await saveManualPart(page, "The first part of the continue seam story.");
    await saveManualPart(page, "The second part of the continue seam story.");
    await saveManualPart(page, "The third part of the continue seam story.");

    await focusPart(page, 0);
    await page.keyboard.press("Space");
    await page.waitForSelector(".stream-card", { timeout: 30_000 });
    await page.waitForSelector(".stream-card", { state: "detached", timeout: 30_000 });

    // ¶3 must no longer be on the line: the new take is a child of ¶1, not
    // an extension of the old leaf.
    await page.waitForFunction(() => document.querySelectorAll(".manuscript-part").length === 2, undefined, { timeout: 15_000 });
    assert.match(
      await page.locator(".manuscript-part").nth(1).locator(".part-gutter-waymark").innerText(),
      /¶ 2 ×2/u,
      "the new take must be a sibling of the old ¶2, not an extension of the old leaf ¶3"
    );
  } finally {
    await teardown(app);
  }
});

// Finding 4: `w` on an earlier focused part must save a sibling take there,
// not append another part after the leaf.
test("Electron review fixes 2: w writes a sibling take of the focused part, not a new leaf part", { timeout: 180_000 }, async () => {
  const app = await launch();
  try {
    const page = app.page;
    await createStory(page, "Write sibling proof");
    await saveManualPart(page, "The first part of the write sibling story.");
    await saveManualPart(page, "The second part of the write sibling story.");
    await saveManualPart(page, "The third part of the write sibling story.");

    // `w`'s sibling take shares the focused part's own parent, so the target
    // must not be the (parentless) root part — ¶2, per the brief's scenario.
    await focusPart(page, 1);
    await page.keyboard.press("w");
    await page.waitForFunction(() => document.querySelector(".composer-eyebrow")?.textContent === "WRITE · A TAKE OF ¶ 2", undefined, { timeout: 15_000 });

    await page.fill(".composer-input", "A sibling take written for the second part.");
    await page.click(".composer-submit");
    await page.waitForFunction(() => document.querySelectorAll(".manuscript-part").length === 2, undefined, { timeout: 15_000 });
    assert.match(
      await page.locator(".manuscript-part").nth(1).locator(".part-gutter-waymark").innerText(),
      /¶ 2 ×2/u,
      "the written take must be a sibling of the old ¶2, not appended after the old leaf ¶3"
    );
    assert.match(
      await page.locator(".manuscript-part").nth(1).locator(".part-prose").innerText(),
      /A sibling take written for the second part\./u
    );
  } finally {
    await teardown(app);
  }
});

// Finding 2: while a simple Fact's Body edit is unsaved, adding a state must
// be blocked, since it would silently discard that edit.
test("Electron review fixes 2: a dirty Fact body disables the state-add links until saved or reverted", { timeout: 180_000 }, async () => {
  const app = await launch();
  try {
    const page = app.page;
    await createStory(page, "Fact state guard proof");
    await page.locator(".tab-facts").click();
    await page.waitForSelector(".new-fact", { timeout: 15_000 });
    await page.click(".new-fact");
    await page.waitForSelector("[data-preserve=\"fact-editor-name\"]", { timeout: 15_000 });
    await page.fill("[data-preserve=\"fact-editor-name\"]", "Lighthouse");
    await page.fill("[data-preserve=\"fact-editor-body\"]", "The lighthouse keeper has kept the light for forty years.");
    await page.click(".fact-editor-save");
    await page.waitForSelector(".fact-states-footer", { timeout: 15_000 });

    const footerButtons = page.locator(".fact-states-footer button");
    assert.equal(await footerButtons.count(), 3);
    for (let index = 0; index < 3; index += 1) {
      assert.equal(await footerButtons.nth(index).isDisabled(), false, "the links start enabled on a freshly saved Fact");
    }

    await page.fill("[data-preserve=\"fact-editor-body\"]", "The lighthouse keeper left without a word.");
    await page.waitForSelector(".fact-pending-bar", { timeout: 15_000 });
    for (let index = 0; index < 3; index += 1) {
      assert.equal(await footerButtons.nth(index).isDisabled(), true, "a dirty Body edit must disable the state-add links");
    }

    await page.click(".fact-editor-revert");
    await page.waitForSelector(".fact-pending-bar", { state: "detached", timeout: 15_000 });
    for (let index = 0; index < 3; index += 1) {
      assert.equal(await footerButtons.nth(index).isDisabled(), false, "Revert must re-enable the state-add links");
    }
  } finally {
    await teardown(app);
  }
});

// Finding 7: a popover owns the keyboard while it is open — a manuscript key
// like `r` must not reach the underlying Write destination.
test("Electron review fixes 2: manuscript keys do nothing behind the Aside popover or the keys sheet", { timeout: 180_000 }, async () => {
  const app = await launch();
  try {
    const page = app.page;
    await createStory(page, "Popover key containment proof");
    await saveManualPart(page, "The only part of the popover containment story.");

    await page.click(".aside-popout");
    await page.waitForSelector(".aside-popover", { timeout: 15_000 });
    await page.keyboard.press("r");
    const misroutedInAside = await page.locator(".stream-card").waitFor({ state: "visible", timeout: 1_500 }).then(() => true).catch(() => false);
    assert.equal(misroutedInAside, false, "r must not start a retake while the Aside popover is open");

    await page.keyboard.press("Escape");
    await page.waitForSelector(".aside-popover", { state: "detached", timeout: 15_000 });

    await page.keyboard.press("?");
    await page.waitForSelector(".keys-sheet", { timeout: 15_000 });
    await page.keyboard.press("r");
    const misroutedInKeysSheet = await page.locator(".stream-card").waitFor({ state: "visible", timeout: 1_500 }).then(() => true).catch(() => false);
    assert.equal(misroutedInKeysSheet, false, "r must not start a retake while the keys sheet is open");
  } finally {
    await teardown(app);
  }
});

// Finding 10: T/l/h fetch an inspect result but must also reveal it.
test("Electron review fixes 2: h reveals its result on the Inspect destination", { timeout: 180_000 }, async () => {
  const app = await launch();
  try {
    const page = app.page;
    await createStory(page, "Inspect reveal proof");
    await saveManualPart(page, "The only part of the inspect reveal story.");
    await retakePart(page, 0);
    await page.waitForFunction(() => document.querySelectorAll(".take-gauge-dot").length === 2, undefined, { timeout: 15_000 });

    await page.keyboard.press("h");
    await page.waitForSelector(".tab-content.inspect", { timeout: 15_000 });
    await page.locator(".inspector-result:not(.busy) pre").waitFor({ state: "visible", timeout: 15_000 });
  } finally {
    await teardown(app);
  }
});

// Finding 13: "Use as author's note" must stage the answer, not overwrite a
// saved note before Save note runs.
test("Electron review fixes 2: Use as author's note stages the answer instead of overwriting the saved note", { timeout: 180_000 }, async () => {
  const app = await launch();
  try {
    const page = app.page;
    await createStory(page, "Author note stage proof");
    await saveManualPart(page, "The only part anchors the Aside session.");

    await page.fill('[data-preserve="authors-note"]', "keep me");
    await page.click(".note-save");
    await page.waitForFunction(() => document.querySelector(".toast")?.textContent === "Done", undefined, { timeout: 15_000 });

    await page.click(".aside-popout");
    await page.waitForSelector(".aside-popover", { timeout: 15_000 });
    await page.fill(".aside-popover .aside-question", "What happens next?");
    await page.click(".aside-popover .aside-ask");
    await page.waitForFunction(
      () => (document.querySelector(".aside-popover .aside-turn .aside-answer")?.textContent?.length ?? 0) > 0,
      undefined,
      { timeout: 30_000 }
    );
    const answer = await page.locator(".aside-popover .aside-turn .aside-answer").innerText();

    await page.locator(".aside-popover .aside-turn-use summary").click();
    await page.click(".aside-popover .aside-use-note");
    await page.waitForFunction(() => document.querySelector(".toast")?.textContent?.includes("Answer placed in the Author's Note") === true, undefined, { timeout: 15_000 });
    await page.waitForSelector(".aside-popover", { state: "detached", timeout: 15_000 });

    assert.equal(await page.locator('[data-preserve="authors-note"]').inputValue(), answer, "the field must show the staged answer");

    // The saved note must be untouched until Save note runs: reselecting
    // this same story guards on the unsaved draft and, on discard, reloads
    // the persisted value fresh from the server.
    await goToLibrary(page);
    await page.locator(".story-row").filter({ hasText: "Author note stage proof" }).click();
    await page.waitForSelector('.modal-card[aria-label="Discard unsaved edits?"]', { timeout: 15_000 });
    await page.click(".modal-submit");
    await page.waitForFunction(() => document.querySelector(".story-title")?.textContent === "Author note stage proof", undefined, { timeout: 15_000 });
    assert.equal(await page.locator('[data-preserve="authors-note"]').inputValue(), "keep me", "the saved note must be unchanged until Save note runs");
  } finally {
    await teardown(app);
  }
});
