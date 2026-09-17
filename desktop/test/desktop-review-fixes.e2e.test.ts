/** Regression coverage for the phase 6 review-fixes brief
 * (scratchpad/spec/06-review-fixes.md): one Electron launch per `test()`,
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
import { closeDesktopApp, editPart, goToLibrary, openSettingsSection } from "./electron-test-helpers.js";

const appPath = process.env.AI_1667_DESKTOP_APP_PATH;
const shortcut = process.platform === "darwin" ? "Meta" : "Control";

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
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-review-fixes-e2e-"));
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-review-fixes-state-e2e-"));
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

// Findings 1, 2, 13.
test("Electron review fixes: Fact drafts survive a cancelled Fact switch and a cancelled story switch, and a simple Fact can gain a state", { timeout: 180_000 }, async () => {
  const app = await launch();
  try {
    const page = app.page;
    await createStory(page, "Facts guard proof A");
    await saveManualPart(page, "A part for the state to anchor to.");
    await createStory(page, "Facts guard proof B");
    await goToLibrary(page);
    await page.locator(".story-row").filter({ hasText: "Facts guard proof A" }).click();
    await page.waitForFunction(() => document.querySelector(".story-title")?.textContent === "Facts guard proof A", undefined, { timeout: 15_000 });

    await page.locator(".tab-facts").click();
    await page.waitForSelector(".new-fact", { timeout: 15_000 });
    await page.click(".new-fact");
    await page.waitForSelector("[data-preserve=\"fact-editor-name\"]", { timeout: 15_000 });
    await page.fill("[data-preserve=\"fact-editor-name\"]", "Keeper");
    await page.fill("[data-preserve=\"fact-editor-body\"]", "The keeper has kept the light for forty years.");
    await page.click(".fact-editor-save");
    await page.waitForFunction(
      () => [...document.querySelectorAll(".fact-card h3")].some((element) => element.textContent === "Keeper"),
      undefined, { timeout: 15_000 }
    );

    // Finding 13: a saved simple (one-body-state) Fact must still offer the
    // state-add links below its Body field — "+ End here" turns it stateful.
    await page.waitForSelector(".fact-states-footer", { timeout: 15_000 });
    await page.locator(".fact-states-footer button", { hasText: "End here" }).click();
    await page.waitForFunction(() => document.querySelectorAll(".fact-state-row").length === 2, undefined, { timeout: 15_000 });

    // A second Fact to switch between for finding 2.
    await page.click(".new-fact");
    await page.waitForSelector("[data-preserve=\"fact-editor-name\"]", { timeout: 15_000 });
    await page.fill("[data-preserve=\"fact-editor-name\"]", "Companion");
    await page.fill("[data-preserve=\"fact-editor-body\"]", "A travel companion who never speaks first.");
    await page.click(".fact-editor-save");
    await page.waitForFunction(
      () => [...document.querySelectorAll(".fact-card h3")].some((element) => element.textContent === "Companion"),
      undefined, { timeout: 15_000 }
    );
    await page.fill("[data-preserve=\"fact-editor-name\"]", "Companion Draft");

    // Finding 2: selecting a different Fact while dirty must confirm first;
    // Cancel must leave the dirty draft exactly where it was.
    await page.locator(".fact-card").filter({ hasText: "Keeper" }).locator(".fact-row-select").click();
    await page.waitForSelector('.modal-card[aria-label="Discard unsaved edits?"]', { timeout: 15_000 });
    await page.click(".modal-cancel");
    await page.waitForSelector(".modal-card", { state: "detached", timeout: 15_000 });
    assert.equal(await page.locator("[data-preserve=\"fact-editor-name\"]").inputValue(), "Companion Draft", "Cancel must keep the dirty draft");

    // Re-selecting the Fact that is already open must never ask, and must
    // never touch the draft either.
    await page.locator(".fact-card").filter({ hasText: "Companion" }).locator(".fact-row-select").click();
    assert.equal(await page.locator(".modal-card").count(), 0, "selecting the already-open Fact must not prompt");
    assert.equal(await page.locator("[data-preserve=\"fact-editor-name\"]").inputValue(), "Companion Draft");

    // Confirming the discard actually switches.
    await page.locator(".fact-card").filter({ hasText: "Keeper" }).locator(".fact-row-select").click();
    await page.waitForSelector('.modal-card[aria-label="Discard unsaved edits?"]', { timeout: 15_000 });
    await page.click(".modal-submit");
    await page.waitForFunction(
      (expected) => (document.querySelector("[data-preserve=\"fact-editor-name\"]") as HTMLInputElement | null)?.value === expected,
      "Keeper",
      { timeout: 15_000 }
    );

    // Finding 1: a dirty Fact editor must also guard switching stories.
    await page.fill("[data-preserve=\"fact-editor-name\"]", "Keeper Renamed");
    await goToLibrary(page);
    await page.locator(".story-row").filter({ hasText: "Facts guard proof B" }).click();
    await page.waitForSelector('.modal-card[aria-label="Discard unsaved edits?"]', { timeout: 15_000 });
    await page.click(".modal-cancel");
    await page.waitForSelector(".modal-card", { state: "detached", timeout: 15_000 });
    assert.equal(await page.locator(".story-title").innerText(), "Facts guard proof A", "Cancel must keep the writer on the original story");
    // Cancel left the Library destination showing (the story-row click always
    // navigates there); return to Facts to confirm the draft itself survived.
    await page.locator(".tab-facts").click();
    await page.waitForSelector("[data-preserve=\"fact-editor-name\"]", { timeout: 15_000 });
    assert.equal(await page.locator("[data-preserve=\"fact-editor-name\"]").inputValue(), "Keeper Renamed", "Cancel must keep the Fact draft");
  } finally {
    await teardown(app);
  }
});

// Findings 4, 5.
test("Electron review fixes: Discard clears a part draft, and Cmd/Ctrl+S saves only the visible editor", { timeout: 180_000 }, async () => {
  const app = await launch();
  try {
    const page = app.page;
    await createStory(page, "Save hygiene proof");
    await saveManualPart(page, "The first part of the save hygiene story.");
    await saveManualPart(page, "The second part of the save hygiene story.");

    // Finding 4: leave a hidden part draft, then dirty a Fact and save with
    // the chord — only the Fact must save.
    const text = await editPart(page, 0);
    await text.fill("A part draft the chord must not touch.");
    await page.keyboard.press("Escape");
    await page.waitForSelector(".part-text", { state: "detached", timeout: 15_000 });
    assert.equal(await page.locator(".manuscript-part").first().evaluate((el) => el.classList.contains("dirty")), true, "the part draft is unsaved");

    await page.locator(".tab-facts").click();
    await page.waitForSelector(".new-fact", { timeout: 15_000 });
    await page.click(".new-fact");
    await page.waitForSelector("[data-preserve=\"fact-editor-name\"]", { timeout: 15_000 });
    await page.fill("[data-preserve=\"fact-editor-name\"]", "Chord target");
    await page.fill("[data-preserve=\"fact-editor-body\"]", "Only this Fact should save on the chord.");
    await page.keyboard.press(`${shortcut}+s`);
    await page.waitForFunction(() => document.querySelector(".toast")?.textContent?.includes("Fact saved") === true, undefined, { timeout: 15_000 });
    assert.equal(await page.locator(".fact-card").count(), 1, "the chord must have created the Fact");

    await page.locator(".tab-write").click();
    await page.waitForSelector(".manuscript-part", { timeout: 15_000 });
    assert.match(await page.locator(".story-save-state").innerText(), /unsaved edits/iu, "the part draft must still be unsaved after the Fact chord");
    assert.equal(await page.locator(".manuscript-part").first().evaluate((el) => el.classList.contains("dirty")), true, "the part draft must still show unsaved");

    // Finding 5: Discard must clear the draft, not just leave edit mode.
    // (The ✎ gutter mark is not used here: a manually written part is
    // permanently "human" and keeps showing ✎ regardless of draft state —
    // the `.dirty` class is the one that tracks the actual unsaved draft.)
    const secondText = await editPart(page, 1);
    await secondText.fill("This text must vanish on Discard.");
    await page.locator(".part-discard").click();
    await page.waitForSelector(".part-text", { state: "detached", timeout: 15_000 });
    assert.match(await page.locator(".manuscript-part").nth(1).locator(".part-prose").innerText(), /The second part of the save hygiene story\./u, "Discard must restore the saved text");
    assert.equal(await page.locator(".manuscript-part").nth(1).evaluate((el) => el.classList.contains("dirty")), false, "Discard must clear the dirty waymark");
  } finally {
    await teardown(app);
  }
});

// Finding 6.
test("Electron review fixes: switching takes focuses the requested part, not the leaf it remembers", { timeout: 180_000 }, async () => {
  const app = await launch();
  try {
    const page = app.page;
    await createStory(page, "Take switch fix proof");
    await saveManualPart(page, "The first part of the take switch story.");
    await saveManualPart(page, "The second part, first take.");
    await saveManualPart(page, "The third part, continuing the first take.");

    await focusPart(page, 1);
    await retakePart(page, 1);
    await page.waitForFunction(() => document.querySelectorAll(".manuscript-part").length === 2, undefined, { timeout: 15_000 });
    // The new take is already the effectively-focused part (by the leaf
    // fallback, `focusedPartId` itself is still whatever was last clicked
    // explicitly — the pre-retake take). Focus part 1 first to "unstick"
    // that stale value, so the next click is a real, listened-for focus
    // change onto the new take rather than a no-op click on an element that
    // has no click handler because it is already effectively focused.
    await focusPart(page, 0);
    await focusPart(page, 1);

    await page.keyboard.press("ArrowLeft");
    await page.waitForFunction(() => document.querySelectorAll(".manuscript-part").length === 3, undefined, { timeout: 15_000 });
    await page.waitForFunction(() => document.querySelectorAll(".manuscript-part")[1]?.classList.contains("focused") === true, undefined, { timeout: 15_000 });
    assert.equal(await page.locator(".manuscript-part").nth(2).evaluate((el) => el.classList.contains("focused")), false, "focus must land on the switched-to take, not the leaf it remembers");
    assert.match(
      await page.locator(".manuscript-part.focused .part-take-count").innerText(),
      /take 1\/2/u,
      "the focused element must be the take (which has a sibling), not the childless leaf"
    );
  } finally {
    await teardown(app);
  }
});

// Findings 7, 9.
test("Electron review fixes: C breaks at the focused part, and u undoes the last break add or remove", { timeout: 180_000 }, async () => {
  const app = await launch();
  try {
    const page = app.page;
    await createStory(page, "Chapter break fix proof");
    await saveManualPart(page, "The first part of the chapter break story.");
    await saveManualPart(page, "The second part of the chapter break story.");
    await saveManualPart(page, "The third part of the chapter break story.");

    await focusPart(page, 0);
    await page.keyboard.press("C");
    await page.waitForSelector(".modal-card", { timeout: 15_000 });
    await page.click(".modal-submit");
    await page.waitForFunction(() => document.querySelector(".toast")?.textContent?.includes("Done") === true, undefined, { timeout: 15_000 });

    await page.locator(".tab-chapters").click();
    await page.waitForFunction(() => document.querySelectorAll(".chapter-card").length === 2, undefined, { timeout: 15_000 });
    assert.match(await page.locator(".chapter-card").nth(0).innerText(), /¶ 1–1/u, "C must break right after the focused part, not the leaf");

    await page.keyboard.press("u");
    await page.waitForFunction(() => document.querySelectorAll(".chapter-card").length === 1, undefined, { timeout: 15_000 });
    await page.waitForFunction(() => document.querySelector(".toast")?.textContent?.includes("Chapter break removed") === true, undefined, { timeout: 15_000 });

    await page.keyboard.press("u");
    await page.waitForFunction(() => document.querySelectorAll(".chapter-card").length === 2, undefined, { timeout: 15_000 });
    await page.waitForFunction(() => document.querySelector(".toast")?.textContent?.includes("Chapter break restored") === true, undefined, { timeout: 15_000 });
    assert.match(await page.locator(".chapter-card").nth(0).innerText(), /¶ 1–1/u, "u must bring back the same break");
  } finally {
    await teardown(app);
  }
});

// Finding 11.
test("Electron review fixes: a control's own arrow key never also runs a manuscript command", { timeout: 180_000 }, async () => {
  const app = await launch();
  try {
    const page = app.page;
    await createStory(page, "Control containment proof");
    await saveManualPart(page, "The only part of the control containment story.");
    await retakePart(page, 0);
    await page.waitForFunction(() => document.querySelectorAll(".take-gauge-dot").length === 2, undefined, { timeout: 15_000 });
    const takeCountBefore = await page.locator(".part-take-count").innerText();

    await page.locator(".tab-settings").click();
    await page.waitForSelector(".settings-editor", { timeout: 15_000 });
    await openSettingsSection(page, "sampling");
    const temperature = page.locator('[data-settings-field="profile.temperature"]');
    await temperature.waitFor({ state: "visible", timeout: 15_000 });
    const scalar = page.locator(".scalar").filter({ has: temperature });
    const before = await temperature.inputValue();
    await scalar.locator(".scalar-step-up").focus();
    // ArrowLeft, not ArrowRight: the take just retaken is already the last
    // sibling, so "take-next" (ArrowRight's NAV action) would be a no-op at
    // that boundary and hide a misrouted key; "take-previous" (ArrowLeft)
    // actually has somewhere to move to.
    await page.keyboard.press("ArrowLeft");
    await page.waitForFunction(
      (expected) => (document.querySelector('[data-settings-field="profile.temperature"]') as HTMLInputElement | null)?.value !== expected,
      before,
      { timeout: 15_000 }
    );

    await page.locator(".tab-write").click();
    await page.waitForSelector(".manuscript-part", { timeout: 15_000 });
    assert.equal(await page.locator(".part-take-count").innerText(), takeCountBefore, "the arrow key that steps the scalar must not also switch the take on Write");
  } finally {
    await teardown(app);
  }
});

// Findings 15, 16.
test("Electron review fixes: the Aside popover streams a live answer and keeps its own field focused through a re-render", { timeout: 180_000 }, async () => {
  const app = await launch();
  try {
    const page = app.page;
    await createStory(page, "Aside popover fix proof");
    await page.fill(".composer-input", "The only part anchors the Aside session.");
    await page.click(".composer-manual");
    await page.waitForSelector(".manuscript-part", { timeout: 15_000 });
    await page.waitForSelector(".aside-session-picker", { timeout: 15_000 });

    await page.click(".aside-popout");
    await page.waitForSelector(".aside-popover", { timeout: 15_000 });

    // Finding 15: the popover must show its own live answer while streaming.
    await page.fill(".aside-popover .aside-question", "Question one for streaming");
    await page.click(".aside-popover .aside-ask");
    await page.waitForFunction(
      () => (document.querySelector(".aside-popover .aside-live-answer")?.textContent?.length ?? 0) > 0,
      undefined,
      { timeout: 15_000 }
    );

    // Finding 16: type a fresh draft while the first answer is still
    // streaming, so its completion (a full re-render, since `busy` flips to
    // false) lands while the popover's own field is focused and dirty.
    const popoverQuestion = page.locator(".aside-popover .aside-question");
    await popoverQuestion.fill("next thought");
    await page.waitForFunction(
      (expected) => [...document.querySelectorAll(".aside-popover .aside-turn")].some((turn) =>
        turn.querySelector(".aside-question-line")?.textContent === expected),
      "Question one for streaming",
      { timeout: 30_000 }
    );

    await page.keyboard.press("r");
    const misroutedStream = await page.locator(".manuscript-part.streaming").first()
      .waitFor({ state: "visible", timeout: 1_500 }).then(() => true).catch(() => false);
    assert.equal(misroutedStream, false, "the keystroke must reach the popover field, not run a retake command");
    assert.equal(await popoverQuestion.inputValue(), "next thoughtr", "the popover field must keep focus and its typed draft across the re-render");
  } finally {
    await teardown(app);
  }
});
