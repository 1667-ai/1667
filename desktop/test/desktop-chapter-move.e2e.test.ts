import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
// Playwright is supplied by the desktop release workspace.
// @ts-ignore The root backend workspace does not install the desktop lane.
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { closeDesktopApp, createStory, saveManualPart } from "./electron-test-helpers.js";

const appPath = process.env.AI_1667_DESKTOP_APP_PATH;

interface Box { readonly left: number; readonly right: number; readonly top: number; readonly width: number; readonly height: number }

// Phase B (scratchpad/spec2/B-move-chapter-break.md, §3): the Chapters
// ruler's break handle drags to a new seam, `u` undoes the move, and the
// handle steps with the arrow keys once focused.
test("Electron Chapters: the break handle drags, undoes with u, and steps with the arrow keys", { timeout: 180_000 }, async () => {
  const launched = await launch();
  const { page } = launched;
  try {
    await createStory(page, "Chapter move story");
    await saveManualPart(page, "Part one of the story.");
    await saveManualPart(page, "Part two of the story.");
    await saveManualPart(page, "Part three of the story.");
    await saveManualPart(page, "Part four of the story.");

    await focusPart(page, 1);
    await page.locator(".tab-chapters").click();
    await page.waitForSelector(".new-chapter", { timeout: 15_000 });
    assert.equal(await page.locator(".new-chapter").innerText(), "+ Break at ¶ 2");
    await page.click(".new-chapter");
    await page.waitForSelector(".modal-card", { timeout: 15_000 });
    await page.click(".modal-submit");
    await page.waitForFunction(() => document.querySelectorAll(".chapter-card").length >= 2, undefined, { timeout: 15_000 });
    await page.waitForSelector(".chapter-ruler-handle", { timeout: 15_000 });

    // 1. Drag the handle from the boundary after ¶ 2 to the boundary after
    // ¶ 3. No summary exists yet, so the move needs no confirmation.
    const boxes = await handleAndCellBoxes(page);
    await page.mouse.move(boxes.handle.left + boxes.handle.width / 2, boxes.handle.top + boxes.handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(boxes.cells[2]!.right, boxes.handle.top + boxes.handle.height / 2, { steps: 8 });
    await page.mouse.up();

    await page.waitForFunction(
      () => document.querySelector(".toast")?.textContent?.includes("Break moved to ¶ 3") === true,
      undefined,
      { timeout: 15_000 }
    );
    assert.equal(await page.locator(".chapter-ruler-mark").count(), 2, "the ruler still names two chapters");
    assert.ok(
      (await firstChapterMeta(page)).includes("¶ 1–3"),
      "chapter one now covers ¶ 1-3"
    );

    // 2. `u` with no field focused undoes the move.
    await page.keyboard.press("u");
    await page.waitForFunction(
      () => document.querySelector(".toast")?.textContent?.includes("moved back") === true,
      undefined,
      { timeout: 15_000 }
    );
    assert.ok((await firstChapterMeta(page)).includes("¶ 1–2"), "the break is back after ¶ 2");

    // 3. Summarize chapter one — dry-run, so no fake model server is needed
    // — then prove a move that would remove a summary asks first. Cancel
    // leaves the break, and its summary, exactly where they were.
    await page.locator(".chapter-card").first().locator(".chapter-summarize").click();
    await page.waitForFunction(
      () => document.querySelector(".chapter-card")?.querySelector(".chapter-summary-preview") !== null,
      undefined,
      { timeout: 15_000 }
    );
    await page.locator(".chapter-ruler-handle").focus();
    await page.keyboard.press("ArrowRight");
    await page.waitForSelector(".modal-card", { timeout: 15_000 });
    assert.equal(await page.locator(".modal-card h2").innerText(), "Move chapter break");
    assert.equal(
      await page.locator(".modal-card p").innerText(),
      "Moving this break removes the summary of chapter 1."
    );
    await page.click(".modal-cancel");
    await page.waitForSelector(".modal-card", { state: "detached", timeout: 15_000 });
    assert.ok((await firstChapterMeta(page)).includes("¶ 1–2"), "cancel leaves the break after ¶ 2");
    assert.equal(
      await page.locator(".chapter-card").first().locator(".chapter-summary-preview").count(),
      1,
      "cancel keeps the summary"
    );

    // 4. Confirming the same move removes the summary and moves the break.
    await page.locator(".chapter-ruler-handle").focus();
    await page.keyboard.press("ArrowLeft");
    await page.waitForSelector(".modal-card", { timeout: 15_000 });
    await page.click(".modal-submit");
    await page.waitForFunction(
      () => {
        const text = document.querySelector(".toast")?.textContent ?? "";
        return text.includes("Break moved to ¶ 1") && text.includes("summary removed");
      },
      undefined,
      { timeout: 15_000 }
    );
    assert.ok((await firstChapterMeta(page)).includes("¶ 1–1"), "the break moved to after ¶ 1");
    assert.equal(
      await page.locator(".chapter-card").first().locator(".chapter-summary-preview").count(),
      0,
      "the confirmed move removed the summary"
    );

    // Pressing ArrowLeft again does nothing — a chapter keeps at least one
    // part, and there is no summary left to ask about. The toast is
    // time-based and may already have cleared on its own by now, so prove
    // the no-op through the chapter's own part range.
    await page.locator(".chapter-ruler-handle").focus();
    await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(300);
    assert.equal(await page.locator(".modal-card").count(), 0, "no summary left means nothing to ask about");
    assert.ok((await firstChapterMeta(page)).includes("¶ 1–1"), "chapter one still holds just ¶ 1");
  } finally {
    await teardown(launched);
  }
});

async function focusPart(page: Page, index: number): Promise<void> {
  await page.locator(".manuscript-part").nth(index).locator(".part-prose").click();
  await page.waitForFunction(
    (expected) => document.querySelectorAll(".manuscript-part")[expected]?.classList.contains("focused") === true,
    index,
    { timeout: 15_000 }
  );
}

async function firstChapterMeta(page: Page): Promise<string> {
  return await page.locator(".chapter-card").first().locator(".chapter-card-meta").innerText();
}

async function handleAndCellBoxes(page: Page): Promise<{ readonly handle: Box; readonly cells: readonly Box[] }> {
  // No named const bindings inside this callback: tsx/esbuild wraps a named
  // function in a `__name(...)` call that does not exist once Playwright
  // re-parses this function's stringified source in the page (see
  // electron-test-helpers.ts's waitForRenderQuiet comment).
  return await page.evaluate(() => ({
    handle: (({ left, right, top, width, height }) => ({ left, right, top, width, height }))(
      document.querySelector(".chapter-ruler-handle")!.getBoundingClientRect()
    ),
    cells: [...document.querySelectorAll(".chapter-ruler-part")].map(
      (cell) => (({ left, right, top, width, height }) => ({ left, right, top, width, height }))(cell.getBoundingClientRect())
    )
  }));
}

interface LaunchedApp {
  readonly app: ElectronApplication;
  readonly page: Page;
  readonly directory: string;
}

async function launch(): Promise<LaunchedApp> {
  if (appPath === undefined || appPath.length === 0) {
    throw new Error("AI_1667_DESKTOP_APP_PATH must point to the built Electron main entry.");
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-chapter-move-e2e-"));
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
  const page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  await page.waitForSelector(".new-story-button", { timeout: 30_000 });
  return { app, page, directory };
}

async function teardown(launched: LaunchedApp): Promise<void> {
  await closeDesktopApp(launched.app);
  await rm(launched.directory, { recursive: true, force: true });
}
