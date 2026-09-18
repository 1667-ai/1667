import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
// Playwright is supplied by the desktop release workspace.
// @ts-ignore The root backend workspace does not install the desktop lane.
import { _electron as electron, type Page } from "playwright";
import { closeDesktopApp, goToLibrary, goToProjectSettings } from "./electron-test-helpers.js";

const appPath = process.env.AI_1667_DESKTOP_APP_PATH;

test("Electron navigates Aside history buckets and anchors new sessions at the focused part", { timeout: 120_000 }, async () => {
  assert.ok(appPath, "AI_1667_DESKTOP_APP_PATH must point to the built Electron main entry.");
  const directory = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-aside-history-e2e-"));
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
    await createStory(page, "Aside history");

    const unanchoredQuestion = "Which promise is still unanchored?";
    await ask(page, unanchoredQuestion);
    await waitForAsideQuestion(page, unanchoredQuestion);
    assert.ok(await optionValue(page, "unanchored"), "the unanchored history bucket must be visible");

    await addPart(page, "The first anchored passage.", 1);
    await page.locator(".aside-anchor-picker").selectOption("current");
    await waitForAsideBucket(page, "current");
    const firstAnchoredQuestion = "What belongs to the first passage?";
    await ask(page, firstAnchoredQuestion);
    await waitForAsideQuestion(page, firstAnchoredQuestion);

    await addPart(page, "The second anchored passage.", 2);
    await page.locator(".aside-anchor-picker").selectOption("current");
    await waitForAsideBucket(page, "current");
    const secondAnchoredQuestion = "What belongs to the second passage?";
    await ask(page, secondAnchoredQuestion);
    await waitForAsideQuestion(page, secondAnchoredQuestion);

    const historical = await page.locator(".aside-anchor-picker option").evaluateAll((options) => options
      .map((option) => {
        const item = option as HTMLOptionElement;
        return { value: item.value, label: item.textContent ?? "" };
      })
      .find((option) => option.value !== "current" && option.value !== "unanchored"));
    assert.ok(historical, "an older anchored history bucket must be visible");
    assert.match(historical.label, /session/u);
    const anchorPicker = page.locator(".aside-anchor-picker");

    await installDelayedAsideRead(page);
    await page.evaluate(() => {
      (window as Window & { __delayNextAsideRead?: boolean }).__delayNextAsideRead = true;
    });
    await page.locator(".aside-anchor-picker").selectOption(historical.value);
    await page.waitForFunction(
      () => (window as Window & { __delayedAsideRead?: boolean }).__delayedAsideRead === true,
      undefined,
      { timeout: 15_000 }
    );
    // R-12: Refresh library now lives in Settings › Desktop, alongside the
    // rest of the Project block. The inspector (and so the Aside history
    // this scenario checks) is a Write-destination concern (R-05: it is
    // absent on Library and Settings), so return to Write once the refresh
    // completes before reading it again.
    await goToProjectSettings(page);
    await page.locator(".refresh-button").click();
    await page.waitForFunction(
      () => /^\d+ stor(?:y|ies)$/u.test(document.querySelector(".toast")?.textContent?.trim() ?? ""),
      undefined,
      { timeout: 30_000 }
    );
    await page.locator(".tab-write").click();
    await page.waitForSelector(".aside-anchor-picker", { timeout: 15_000 });
    await waitForAsideQuestion(page, firstAnchoredQuestion);
    assert.equal(await page.locator(".aside-anchor-picker").inputValue(), historical.value,
      "a pending Aside read must survive a same-story library refresh");

    await anchorPicker.focus();
    await anchorPicker.selectOption("current");
    await waitForAsideQuestion(page, secondAnchoredQuestion);
    await page.evaluate(() => {
      const runtime = window as Window & { __delayNextAsideRead?: boolean; __delayedAsideRead?: boolean };
      runtime.__delayedAsideRead = false;
      runtime.__delayNextAsideRead = true;
    });
    await anchorPicker.selectOption(historical.value);
    await page.waitForFunction(
      () => (window as Window & { __delayedAsideRead?: boolean }).__delayedAsideRead === true,
      undefined,
      { timeout: 15_000 }
    );
    await anchorPicker.selectOption("unanchored");
    await waitForAsideQuestion(page, unanchoredQuestion);
    await page.waitForTimeout(1_500);
    assert.equal(await anchorPicker.inputValue(), "unanchored");
    await waitForAsideQuestion(page, unanchoredQuestion);

    await anchorPicker.focus();
    await anchorPicker.selectOption(historical.value);
    await waitForAsideQuestion(page, firstAnchoredQuestion);
    assert.equal(await page.locator(":focus").getAttribute("data-preserve"), "aside-anchor-picker");

    await anchorPicker.focus();
    await anchorPicker.selectOption("unanchored");
    await waitForAsideQuestion(page, unanchoredQuestion);
    assert.equal(await page.locator(":focus").getAttribute("data-preserve"), "aside-anchor-picker");

    await anchorPicker.focus();
    await anchorPicker.selectOption("current");
    await waitForAsideQuestion(page, secondAnchoredQuestion);
    assert.equal(await page.locator(":focus").getAttribute("data-preserve"), "aside-anchor-picker");
    await page.locator(".tab-write").click();
    await page.waitForSelector(".manuscript-part", { timeout: 15_000 });
    // "Write from here" (`.part-switch`) now lives in the part's `···`
    // overflow menu (D-11).
    const firstPart = page.locator(".manuscript-part").first();
    await firstPart.locator(".part-prose").hover();
    await firstPart.locator(".part-more").click();
    await page.waitForSelector(".part-menu", { timeout: 15_000 });
    await page.locator(".part-menu .part-switch").click();
    await page.waitForFunction(() => document.querySelectorAll(".manuscript-part").length === 1, undefined, { timeout: 15_000 });

    const sessionPicker = page.locator(".aside-session-picker");
    await sessionPicker.focus();
    await sessionPicker.selectOption("");
    assert.equal(await page.locator(":focus").getAttribute("data-preserve"), "aside-session-picker");
    assert.equal(await page.locator(".aside-anchor-picker").inputValue(), "current", "new Aside sessions must follow the focused part");
    const branchQuestion = "What changes after returning to the first passage?";
    await ask(page, branchQuestion);
    await waitForAsideQuestion(page, branchQuestion);
    assert.equal(await page.locator(".aside-anchor-picker").inputValue(), "current", "the saved new session must keep the focused part anchor");
  } finally {
    await closeDesktopApp(app);
    await rm(directory, { recursive: true, force: true });
  }
});

test("Electron keeps Aside selectors after a rejected history read", { timeout: 120_000 }, async () => {
  assert.ok(appPath, "AI_1667_DESKTOP_APP_PATH must point to the built Electron main entry.");
  const directory = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-aside-rejected-read-e2e-"));
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
    await createStory(page, "Aside rejected read");

    const unanchoredQuestion = "Which promise is unanchored?";
    await ask(page, unanchoredQuestion);
    await waitForAsideQuestion(page, unanchoredQuestion);
    await addPart(page, "The anchored passage.", 1);
    const anchorPicker = page.locator(".aside-anchor-picker");
    await anchorPicker.selectOption("current");
    await waitForAsideBucket(page, "current");
    const currentQuestion = "What belongs to the anchored passage?";
    await ask(page, currentQuestion);
    await waitForAsideQuestion(page, currentQuestion);
    const sessionPicker = page.locator(".aside-session-picker");
    const previousSession = await sessionPicker.inputValue();
    assert.notEqual(previousSession, "", "the current Aside session must be selected before the rejected read");

    await installRejectedAsideRead(page);
    await page.evaluate(() => {
      (window as Window & { __rejectNextAsideRead?: boolean }).__rejectNextAsideRead = true;
    });
    await anchorPicker.focus();
    await anchorPicker.selectOption("unanchored");
    await page.waitForFunction(
      () => document.querySelector(".toast")?.textContent === "Aside unavailable"
        && (document.querySelector(".error-banner")?.textContent?.trim().length ?? 0) > 0,
      undefined,
      { timeout: 30_000 }
    );
    assert.equal(await anchorPicker.inputValue(), "current");
    assert.equal(await sessionPicker.inputValue(), previousSession);
    assert.equal(await page.locator(":focus").getAttribute("data-preserve"), "aside-anchor-picker");
    await waitForAsideQuestion(page, currentQuestion);
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
  await page.waitForFunction((expected) => document.querySelector(".story-title")?.textContent === expected, title, { timeout: 30_000 });
}

async function addPart(page: Page, text: string, expectedParts: number): Promise<void> {
  await page.locator(".composer-input").fill(text);
  await page.locator(".composer-manual").click();
  await page.waitForFunction((expected) => document.querySelectorAll(".manuscript-part").length === expected, expectedParts, { timeout: 15_000 });
}

async function ask(page: Page, question: string): Promise<void> {
  await page.locator(".aside-question").fill(question);
  await page.locator(".aside-ask").click();
  await page.waitForSelector(".aside-stop", { timeout: 15_000 });
  await page.waitForSelector(".aside-stop", { state: "detached", timeout: 30_000 });
}

async function waitForAsideQuestion(page: Page, question: string): Promise<void> {
  await page.waitForFunction(
    (expected) => [...document.querySelectorAll(".aside-turn")].some((turn) =>
      turn.querySelector(".aside-question-line")?.textContent === expected),
    question,
    { timeout: 30_000 }
  );
}

async function waitForAsideBucket(page: Page, value: string): Promise<void> {
  await page.waitForFunction(
    (expected) => (document.querySelector(".aside-anchor-picker") as HTMLSelectElement | null)?.value === expected,
    value,
    { timeout: 15_000 }
  );
}

async function optionValue(page: Page, value: string): Promise<boolean> {
  return await page.locator(`.aside-anchor-picker option[value="${value}"]`).count() > 0;
}

async function installDelayedAsideRead(page: Page): Promise<void> {
  await page.evaluate(() => {
    const runtime = window as Window & {
      __delayNextAsideRead?: boolean;
      __delayedAsideRead?: boolean;
      __delayedAsideReadInstalled?: boolean;
    };
    if (runtime.__delayedAsideReadInstalled === true) return;
    const postMessage = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function(message: unknown): void {
      const request = message as { readonly type?: unknown; readonly method?: unknown };
      if (runtime.__delayNextAsideRead === true && request.type === "request" && request.method === "getAside") {
        runtime.__delayNextAsideRead = false;
        runtime.__delayedAsideRead = true;
        window.setTimeout(() => postMessage.call(this, message), 1_000);
        return;
      }
      postMessage.call(this, message);
    };
    runtime.__delayedAsideReadInstalled = true;
  });
}

async function installRejectedAsideRead(page: Page): Promise<void> {
  await page.evaluate(() => {
    const runtime = window as Window & {
      __rejectNextAsideRead?: boolean;
      __rejectedAsideReadInstalled?: boolean;
    };
    if (runtime.__rejectedAsideReadInstalled === true) return;
    const postMessage = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function(message: unknown): void {
      const request = message as {
        readonly type?: unknown;
        readonly method?: unknown;
        readonly input?: unknown;
      };
      if (runtime.__rejectNextAsideRead === true
        && request.type === "request"
        && request.method === "getAside"
        && request.input !== null
        && typeof request.input === "object") {
        runtime.__rejectNextAsideRead = false;
        const input = request.input as Record<string, unknown>;
        postMessage.call(this, {
          ...request,
          input: { ...input, storyId: "missing-aside-story-for-focus-proof" }
        });
        return;
      }
      postMessage.call(this, message);
    };
    runtime.__rejectedAsideReadInstalled = true;
  });
}
