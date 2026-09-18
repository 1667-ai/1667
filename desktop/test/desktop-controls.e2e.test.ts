import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
// Playwright is supplied by the desktop release workspace.
// @ts-ignore The root backend workspace does not install the desktop lane.
import { _electron as electron, type Page } from "playwright";
import { closeDesktopApp, goToLibrary, openSettingsSection } from "./electron-test-helpers.js";

const appPath = process.env.AI_1667_DESKTOP_APP_PATH;

// Phase 4a (scratchpad/spec/04-controls-settings-facts-chapters.md, §5) —
// scenarios 1-3. Scenarios 4-5 (Facts, Chapters) below are phase 4b.

test("Electron controls: no range, checkbox, or switch anywhere in the renderer DOM", async () => {
  const app = await launch();
  try {
    const page = app.page;
    await createStory(page, "Controls proof");
    await page.locator(".tab-write").click();
    await page.waitForSelector(".composer-input", { timeout: 15_000 });
    await assertNoRawControls(page);
    await goToLibrary(page);
    await page.locator(".story-row").filter({ hasText: "Controls proof" }).click();
    await page.waitForFunction(() => document.querySelector(".story-title")?.textContent === "Controls proof", undefined, { timeout: 15_000 });
    await page.locator(".tab-facts").click();
    await page.waitForSelector(".tab-content.facts", { timeout: 15_000 });
    await assertNoRawControls(page);
    await page.locator(".tab-chapters").click();
    await page.waitForSelector(".tab-content.chapters", { timeout: 15_000 });
    await assertNoRawControls(page);
    await page.locator(".tab-settings").click();
    await page.waitForSelector(".settings-editor", { timeout: 15_000 });
    await assertNoRawControls(page);
  } finally {
    await teardown(app);
  }
});

test("Electron controls: the temperature scalar steps, flags invalid text, names the pending change, and discards", async () => {
  const app = await launch();
  try {
    const page = app.page;
    await createStory(page, "Scalar proof");
    await page.locator(".tab-settings").click();
    await page.waitForSelector(".settings-editor", { timeout: 15_000 });
    // Temperature lives with the other sampling scalars (Settings › Sampling),
    // not Settings › Profiles as scenario 2 first assumed — see the report.
    await openSettingsSection(page, "sampling");

    const temperature = page.locator('[data-settings-field="profile.temperature"]');
    await temperature.waitFor({ state: "visible", timeout: 15_000 });
    const scalar = page.locator(".scalar").filter({ has: temperature });
    assert.equal(await temperature.inputValue(), "0.8", "the checked-in default profile ships temperature 0.8");

    await scalar.locator(".scalar-step-up").click();
    assert.equal(await temperature.inputValue(), "0.81", "one step up from 0.8 raises the value by the 0.01 step");

    await temperature.fill("abc");
    await page.waitForSelector(".scalar.invalid", { timeout: 15_000 });
    assert.equal(await temperature.inputValue(), "abc", "typing keeps the raw text even though it does not parse");

    const pendingText = await page.locator(".settings-pending-bar").innerText();
    assert.match(pendingText, /temperature/iu);
    assert.match(pendingText, /0\.81/u);

    await page.click(".settings-discard-draft");
    await page.waitForFunction(() => document.querySelector(".settings-discard-draft") === null, undefined, { timeout: 15_000 });
    assert.equal(await temperature.inputValue(), "0.8", "discarding the draft restores the original temperature");
  } finally {
    await teardown(app);
  }
});

test("Electron controls: a Desktop theme swatch sets the theme and its own type", async () => {
  const app = await launch();
  try {
    const page = app.page;
    await createStory(page, "Swatch proof");
    await page.locator(".tab-write").click();
    await page.waitForSelector(".composer-input", { timeout: 15_000 });
    await page.locator(".composer-input").fill("A line to measure the theme font against.");
    await page.locator(".composer-manual").click();
    await page.waitForSelector(".part-prose", { timeout: 15_000 });

    await page.locator(".tab-settings").click();
    await page.waitForSelector(".settings-editor", { timeout: 15_000 });
    await openSettingsSection(page, "desktop");
    await page.locator('.theme-swatch[data-theme="bond"]').click();
    await page.waitForFunction(() => document.documentElement.getAttribute("data-desktop-theme") === "bond", undefined, { timeout: 15_000 });

    await page.locator(".tab-write").click();
    await page.waitForSelector(".part-prose", { timeout: 15_000 });
    const fontFamily = await page.evaluate(() => getComputedStyle(document.querySelector(".part-prose")!).fontFamily);
    assert.match(fontFamily, /Georgia/u);

    // The three named families ship with the application. Without them a
    // machine that lacks them falls back to a system face and every theme
    // renders the same type.
    const loaded = await page.evaluate(async () => {
      await document.fonts.ready;
      return ["IBM Plex Sans", "Literata", "JetBrains Mono"]
        .filter((family) => !document.fonts.check(`16px "${family}"`));
    });
    assert.deepEqual(loaded, [], "every bundled family must load in the packaged app");
  } finally {
    await teardown(app);
  }
});

// Scenario 4: the Facts sheet creates a Fact inline, edits a pending change,
// reverts it, and the consistency check never touches a Fact.
test("Electron controls: Facts creates a Fact in the sheet, names a pending change, and the check never edits a Fact", async () => {
  const app = await launch();
  try {
    const page = app.page;
    await createStory(page, "Facts sheet proof");
    await page.locator(".tab-write").click();
    await page.waitForSelector(".composer-input", { timeout: 15_000 });
    await page.locator(".composer-input").fill("The lighthouse keeper counted the ships every dusk.");
    await page.locator(".composer-manual").click();
    await page.waitForSelector(".part-prose", { timeout: 15_000 });

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
    assert.equal(await page.locator(".fact-card").count(), 1);

    await page.locator(".fact-row-select").first().click();
    await page.waitForSelector(".fact-priority", { timeout: 15_000 });
    await page.locator(".fact-priority .segmented-option", { hasText: "High" }).click();
    await page.waitForSelector(".fact-pending-bar", { timeout: 15_000 });
    const pendingText = await page.locator(".fact-pending-summary").innerText();
    assert.match(pendingText, /priority normal → high/u);

    await page.click(".fact-editor-revert");
    await page.waitForFunction(() => document.querySelector(".fact-pending-bar") === null, undefined, { timeout: 15_000 });

    await page.click(".facts-check-line");
    await page.waitForSelector(".modal-card", { timeout: 15_000 });
    await page.click(".modal-submit");
    await page.waitForSelector(".fact-findings", { timeout: 30_000 });
    assert.equal(await page.locator(".fact-card").count(), 1, "the check must not create or delete a Fact");
    assert.equal(await page.locator(".fact-card h3").innerText(), "Keeper", "the check must not edit a Fact");
  } finally {
    await teardown(app);
  }
});

// Scenario 5: "+ Break at ¶ 2" after focusing part 2 creates a chapter; the
// ruler shows two chapter labels and a caret under ¶ 2; Remove then Restore
// removed brings the break back.
test("Electron controls: Chapters breaks at the focused part, then removes and restores it", async () => {
  const app = await launch();
  try {
    const page = app.page;
    await createStory(page, "Chapters ruler proof");
    await page.locator(".tab-write").click();
    await page.waitForSelector(".composer-input", { timeout: 15_000 });
    await page.locator(".composer-input").fill("The first paragraph opens the story.");
    await page.locator(".composer-manual").click();
    await page.waitForSelector(".part-prose", { timeout: 15_000 });
    await page.locator(".composer-input").fill("The second paragraph turns the story.");
    await page.locator(".composer-manual").click();
    await page.waitForFunction(() => document.querySelectorAll(".manuscript-part").length >= 2, undefined, { timeout: 15_000 });

    await page.locator(".manuscript-part").nth(1).locator(".part-prose").click();
    await page.waitForFunction(() => document.querySelector(".manuscript-part.focused") !== null, undefined, { timeout: 15_000 });

    await page.locator(".tab-chapters").click();
    await page.waitForSelector(".new-chapter", { timeout: 15_000 });
    assert.equal(await page.locator(".new-chapter").innerText(), "+ Break at ¶ 2");
    await page.click(".new-chapter");
    await page.waitForSelector(".modal-card", { timeout: 15_000 });
    await page.click(".modal-submit");
    await page.waitForFunction(() => document.querySelectorAll(".chapter-card").length >= 2, undefined, { timeout: 15_000 });
    assert.equal(await page.locator(".chapter-ruler-mark").count(), 2, "the ruler names both chapters");
    assert.equal(await page.locator(".chapter-ruler-part.focused").count(), 1, "the ruler marks the focused ¶ with a caret");

    await page.locator(".chapter-card").nth(1).locator(".chapter-remove").click();
    await page.waitForSelector(".modal-card", { timeout: 15_000 });
    await page.click(".modal-submit");
    await page.waitForFunction(() => document.querySelectorAll(".chapter-card").length === 1, undefined, { timeout: 15_000 });

    await page.waitForSelector(".restore-chapter", { timeout: 15_000 });
    await page.click(".restore-chapter");
    await page.waitForFunction(() => document.querySelectorAll(".chapter-card").length === 2, undefined, { timeout: 15_000 });
  } finally {
    await teardown(app);
  }
});

// Phase D (scratchpad/spec3/D-layout-and-details.md): the inspector is
// contextual to a story destination — it is absent on Library and Settings,
// which own the full width instead. A section header still toggles its own
// section. At the 960px floor the composer joins the manuscript's own flow
// rather than docking (sticky) over it.
test("Electron controls: the inspector hides on Library and Settings, a section header collapses its section, and the composer joins the flow at 960", async () => {
  const app = await launch();
  try {
    const page = app.page;
    await createStory(page, "Inspector visibility proof");
    await page.locator(".tab-write").click();
    await page.waitForSelector(".composer-input", { timeout: 15_000 });
    await page.locator(".composer-input").fill("A part to measure the composer and inspector against.");
    await page.locator(".composer-manual").click();
    await page.waitForSelector(".part-prose", { timeout: 15_000 });

    const takesHeader = page.locator('[data-inspector-section="takes"] .inspector-section-header');
    const takesBody = page.locator('[data-inspector-section="takes"] .inspector-section-body');
    const before = await takesHeader.getAttribute("aria-expanded");
    await takesHeader.click();
    await page.waitForFunction(
      (expected) => document.querySelector('[data-inspector-section="takes"] .inspector-section-header')?.getAttribute("aria-expanded") !== expected,
      before,
      { timeout: 15_000 }
    );
    const collapsedNow = (await takesHeader.getAttribute("aria-expanded")) === "false";
    assert.equal(await takesBody.evaluate((element) => (element as HTMLElement).hidden), collapsedNow, "the section body's hidden state must follow its own header's toggle");

    await goToLibrary(page);
    assert.equal(await page.locator(".inspector").count(), 0, "the inspector must not render on Library");
    await page.locator(".tab-settings").click();
    await page.waitForSelector(".settings-editor", { timeout: 15_000 });
    assert.equal(await page.locator(".inspector").count(), 0, "the inspector must not render on Settings");

    await page.locator(".tab-write").click();
    await page.waitForSelector(".part-prose", { timeout: 15_000 });
    await app.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(960, 640));
    await page.waitForFunction(() => window.innerWidth <= 960, undefined, { timeout: 5_000 });
    const overlap = await page.evaluate(() => {
      const composer = document.querySelector(".composer")?.getBoundingClientRect();
      if (composer === undefined) return true;
      return [...document.querySelectorAll(".part-prose")].some((part) => {
        const box = part.getBoundingClientRect();
        return composer.top < box.bottom && composer.bottom > box.top;
      });
    });
    assert.equal(overlap, false, "the composer must never overlap a .part-prose box at 960px");
  } finally {
    await teardown(app);
  }
});

async function assertNoRawControls(page: Page): Promise<void> {
  const counts = await page.evaluate(() => ({
    range: document.querySelectorAll("input[type=range]").length,
    checkbox: document.querySelectorAll("input[type=checkbox]").length,
    switchRole: document.querySelectorAll("[role=switch]").length
  }));
  assert.deepEqual(counts, { range: 0, checkbox: 0, switchRole: 0 });
}

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
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-controls-e2e-"));
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-controls-state-e2e-"));
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
