import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
// Playwright is supplied by the desktop release workspace.
// @ts-ignore The root backend workspace does not install the desktop lane.
import { _electron as electron, type Page } from "playwright";
import { closeDesktopApp } from "./electron-test-helpers.js";

const appPath = process.env.AI_1667_DESKTOP_APP_PATH;

test("Electron isolates Aside stories and retains a stopped v2 answer", { timeout: 120_000 }, async () => {
  assert.ok(appPath, "AI_1667_DESKTOP_APP_PATH must point to the built Electron main entry.");
  const directory = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-aside-e2e-"));
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
    await createStory(page, "Aside source");
    await page.fill(".composer-input", "The source part anchors the first Aside session.");
    await page.click(".composer-manual");
    await page.waitForSelector(".manuscript-part", { timeout: 15_000 });
    await page.waitForSelector(".aside-session-picker", { timeout: 15_000 });

    const firstQuestion = "Why did the source lantern go dark?";
    await ask(page, firstQuestion);
    await page.waitForFunction(
      (question) => [...document.querySelectorAll(".aside-turn")].some((turn) =>
        turn.querySelector(".aside-question-line")?.textContent === question
        && (turn.querySelector(".aside-answer")?.textContent?.length ?? 0) > 0),
      firstQuestion,
      { timeout: 30_000 }
    );
    assert.match(await page.locator(".aside-turn").last().innerText(), /Aside \(dry-run\)/u);
    assert.equal(await page.locator(".aside-use").count(), 1);

    await createStory(page, "Aside destination");
    await page.waitForSelector(".aside-session-picker", { timeout: 15_000 });
    assert.equal(await page.locator(".aside-question").inputValue(), "");
    assert.equal(await page.locator(".aside-turn").count(), 0, "a new story must not inherit the old Aside session");

    const secondQuestion = "What belongs to this new manuscript?";
    await ask(page, secondQuestion);
    await page.waitForFunction(
      (question) => [...document.querySelectorAll(".aside-turn")].some((turn) =>
        turn.querySelector(".aside-question-line")?.textContent === question),
      secondQuestion,
      { timeout: 30_000 }
    );
    assert.equal(await page.locator(".aside-turn").count(), 1);
    assert.doesNotMatch(await page.locator(".aside-turn").innerText(), /source lantern/iu);

    const stoppedQuestion = "Stop this new Aside answer after its first words.";
    await page.fill(".aside-question", stoppedQuestion);
    await page.click(".aside-ask");
    await page.waitForFunction(
      () => (document.querySelector(".aside-live-answer")?.textContent?.length ?? 0) > 0,
      { timeout: 15_000 }
    );
    const partialBeforeStop = await page.locator(".aside-live-answer").innerText();
    assert.match(partialBeforeStop, /Aside \(dry-run\)/u);
    await page.click(".aside-stop");
    await page.waitForFunction(
      () => document.querySelector(".aside-stop") === null
        && document.querySelector(".aside-use") !== null
        && (document.querySelector(".aside-live-answer")?.textContent?.length ?? 0) > 0,
      { timeout: 15_000 }
    );
    const retained = await page.locator(".aside-live-answer").innerText();
    assert.ok(retained.length >= partialBeforeStop.length, "stopped Aside text must remain visible");
    assert.equal(await page.getByRole("button", { name: "Use as line" }).count(), 1);
    assert.equal(await page.locator(".aside-turn").count(), 1, "stopped Aside text must not be presented as a saved turn");
    await page.locator(".aside-session-picker").selectOption("");
  } finally {
    await closeDesktopApp(app);
    await rm(directory, { recursive: true, force: true });
  }
});

test("Electron clears empty Aside sessions and preserves a newer question draft", { timeout: 120_000 }, async () => {
  assert.ok(appPath, "AI_1667_DESKTOP_APP_PATH must point to the built Electron main entry.");
  const directory = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-aside-cleanup-e2e-"));
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
    await createStory(page, "Aside cleanup");

    const firstQuestion = "Which answer should disappear after clear?";
    await ask(page, firstQuestion);
    await waitForAsideQuestion(page, firstQuestion);
    assert.equal(await page.locator(".aside-use").count(), 1);
    const firstAnswer = await page.locator(".aside-turn .aside-answer").last().innerText();
    assert.ok(firstAnswer.length > 0);
    await page.locator(".aside-clear-session").click();
    await waitForEmptyAside(page);
    assert.equal(await page.locator(".aside-question").inputValue(), "");
    assert.equal(await page.locator(".aside-card .aside-answer").count(), 0);

    const secondQuestion = "Which answer should disappear after delete?";
    await ask(page, secondQuestion);
    await waitForAsideQuestion(page, secondQuestion);
    assert.equal(await page.locator(".aside-use").count(), 1);
    await page.locator(".aside-delete-turn").click();
    const deleteDialog = page.locator('.modal-card[aria-label="Delete Aside turn"]');
    await deleteDialog.waitFor({ state: "visible", timeout: 15_000 });
    await deleteDialog.locator(".modal-submit").click();
    await waitForEmptyAside(page);
    assert.equal(await page.locator(".aside-question").inputValue(), "");
    assert.equal(await page.locator(".aside-card .aside-answer").count(), 0);

    const submittedQuestion = "What is saved while the next question is typed?";
    await page.locator(".aside-question").fill(submittedQuestion);
    await page.locator(".aside-ask").click();
    await page.waitForSelector(".aside-stop", { timeout: 15_000 });
    const newerQuestion = "A newer question typed during the response.";
    await page.locator(".aside-question").fill(newerQuestion);
    await page.waitForSelector(".aside-stop", { state: "detached", timeout: 30_000 });
    await waitForAsideQuestion(page, submittedQuestion);
    assert.equal(await page.locator(".aside-question").inputValue(), newerQuestion);
  } finally {
    await closeDesktopApp(app);
    await rm(directory, { recursive: true, force: true });
  }
});

async function createStory(page: Page, title: string): Promise<void> {
  await page.click(".new-story-button");
  await page.waitForSelector(".modal-card", { timeout: 15_000 });
  await page.fill(".modal-input", title);
  await page.click(".modal-submit");
  await page.waitForFunction((expected) => document.querySelector(".story-title")?.textContent === expected, title, { timeout: 30_000 });
}

async function ask(page: Page, question: string): Promise<void> {
  await page.fill(".aside-question", question);
  await page.click(".aside-ask");
  await page.waitForFunction(
    (expected) => document.querySelector(".aside-question")?.getAttribute("data-preserve") === "aside-question"
      && document.querySelector(".aside-stop") !== null
      && (document.querySelector(".aside-question") as HTMLTextAreaElement | null)?.value === expected,
    question,
    { timeout: 15_000 }
  );
}

async function waitForAsideQuestion(page: Page, question: string): Promise<void> {
  await page.waitForFunction(
    (expected) => [...document.querySelectorAll(".aside-turn")].some((turn) =>
      turn.querySelector(".aside-question-line")?.textContent === expected),
    question,
    { timeout: 30_000 }
  );
}

async function waitForEmptyAside(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.querySelector(".aside-turn") === null
      && document.querySelector(".aside-use") === null
      && document.querySelector(".aside-live-answer") === null,
    { timeout: 30_000 }
  );
}
