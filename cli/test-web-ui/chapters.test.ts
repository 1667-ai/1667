import { afterEach, expect, test } from "bun:test";
import type { Browser, Locator, Page } from "playwright-core";
import { DRY_RUN_WORD_DELAY_VARIABLE } from "../../server/providers.js";
import { cleanupWebProcesses, scratchProject, spawnWeb, type ReadyWeb } from "../test/web-e2e-fixture.js";
import {
  afterAllHook,
  cleanupWebUiPages,
  collectPageDiagnostics,
  launchChrome,
  openInspectionApi,
  openTestPage
} from "./web-ui-fixture.js";

/**
 * Chapters in a real browser (#409 step 7a): `C`, `u`, the divider menu, the
 * inline rename, chapter summaries, and the chapters panel. Every case checks the SAVED
 * story through a second connection, not only what is on screen.
 */

let browser: Browser | null = null;
async function sharedBrowser(): Promise<Browser> {
  browser ??= await launchChrome();
  return browser;
}
afterAllHook(async () => {
  await browser?.close();
});

afterEach(async () => {
  await cleanupWebUiPages();
  await cleanupWebProcesses();
});

async function spawnChapterWeb(wordDelayMs = 20): Promise<ReadyWeb> {
  const project = await scratchProject();
  return await spawnWeb(
    ["--data", project.dataDir, "--port", "0", "--no-open"],
    { ...project.env, [DRY_RUN_WORD_DELAY_VARIABLE]: String(wordDelayMs) }
  );
}

async function poll(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    if (await check()) return true;
    if (Date.now() - start > timeoutMs) return await check();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForCount(locator: Locator, count: number, timeoutMs = 5_000): Promise<void> {
  expect(await poll(async () => (await locator.count()) === count, timeoutMs)).toBeTrue();
}

async function waitForAttribute(locator: Locator, name: string, value: string): Promise<void> {
  expect(await poll(async () => (await locator.getAttribute(name)) === value)).toBeTrue();
}

/** Saves a screenshot as `web-<name>.png` into the directory named by
 * `AI_1667_WEB_UI_SCREENSHOTS`; does nothing when it is not set. */
async function screenshot(page: Page, name: string): Promise<void> {
  const dir = process.env.AI_1667_WEB_UI_SCREENSHOTS;
  if (dir === undefined) return;
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${dir}/web-${name}.png` });
}

function part(page: Page, text: string): Locator {
  return page.locator(".part").filter({ hasText: text });
}

/** A story `A → B → C` of plain human parts. */
async function seedThreeParts(web: ReadyWeb, title: string) {
  const api = await openInspectionApi(web);
  const created = await api.createStory(title);
  const pA = await api.createNode(created.id, { text: "A: the opening part.", parentId: null });
  const a = pA.path.at(-1)!.id;
  const pB = await api.createNode(created.id, { text: "B: the middle part.", parentId: a });
  const b = pB.path.at(-1)!.id;
  const pC = await api.createNode(created.id, { text: "C: the last part.", parentId: b });
  return { api, storyId: created.id, a, b, c: pC.path.at(-1)!.id };
}

async function openStory(web: ReadyWeb, storyId: string, title: string): Promise<Page> {
  const page = await openTestPage(await sharedBrowser());
  await page.goto(web.url);
  await page.getByRole("button", { name: "New story" }).waitFor();
  await page.evaluate((id) => { location.hash = `#/story/${id}`; }, storyId);
  await page.getByRole("heading", { name: title }).waitFor();
  return page;
}

test("case 1: C ends the chapter, opens the new title for naming, and C again is refused", async () => {
  const web = await spawnChapterWeb();
  const seeded = await seedThreeParts(web, "End A Chapter");
  const page = await openStory(web, seeded.storyId, "End A Chapter");
  const diagnostics = await collectPageDiagnostics(page);
  await part(page, "B:").click();
  await waitForAttribute(part(page, "B:"), "aria-current", "true");

  await page.keyboard.press("Shift+C");
  const title = page.getByRole("textbox", { name: "Chapter title" });
  await title.waitFor();
  expect(await poll(() => title.evaluate((element) => element === document.activeElement))).toBeTrue();
  await page.keyboard.type("The Turn");
  await screenshot(page, "7a-chapter-rename");
  await page.keyboard.press("Enter");
  await waitForCount(title, 0);
  await page.getByRole("button", { name: "The Turn" }).waitFor();

  const saved = await seeded.api.loadStory(seeded.storyId);
  expect(saved.chapterBreaks).toHaveLength(1);
  expect(saved.chapterBreaks[0]!.parentPartId).toBe(seeded.b);
  expect(saved.chapterBreaks[0]!.title).toBe("The Turn");
  expect(await poll(() => part(page, "B:").evaluate((element) => element === document.activeElement))).toBeTrue();
  await screenshot(page, "7a-chapter-divider");

  await page.keyboard.press("Shift+C");
  await page.getByText("Chapter One already ends here.").waitFor();
  expect((await seeded.api.loadStory(seeded.storyId)).chapterBreaks).toHaveLength(1);
  await page.waitForTimeout(300);
  expect(diagnostics.consoleErrors).toEqual([]);
  expect(diagnostics.cspViolations).toEqual([]);
}, 60_000);

test("case 2: u takes back an added break", async () => {
  const web = await spawnChapterWeb();
  const seeded = await seedThreeParts(web, "Undo A Break");
  const page = await openStory(web, seeded.storyId, "Undo A Break");
  await part(page, "B:").click();
  await waitForAttribute(part(page, "B:"), "aria-current", "true");
  await page.keyboard.press("Shift+C");
  await page.getByRole("textbox", { name: "Chapter title" }).waitFor();
  await page.keyboard.press("Escape");
  await waitForCount(page.locator(".chapter-divider"), 1);
  expect((await seeded.api.loadStory(seeded.storyId)).chapterBreaks).toHaveLength(1);

  await page.keyboard.press("u");
  await waitForCount(page.locator(".chapter-divider"), 0);
  expect((await seeded.api.loadStory(seeded.storyId)).chapterBreaks).toHaveLength(0);
  await page.keyboard.press("u");
  await page.getByText("Nothing to undo.").waitFor();
}, 60_000);

test("case 3: Remove break is immediate and u restores the break with its title", async () => {
  const web = await spawnChapterWeb();
  const seeded = await seedThreeParts(web, "Remove A Break");
  await seeded.api.createChapterBreak(seeded.storyId, seeded.b, "Second");
  const page = await openStory(web, seeded.storyId, "Remove A Break");
  await page.getByRole("button", { name: "Second" }).waitFor();

  await page.getByRole("button", { name: "Chapter actions" }).click();
  await screenshot(page, "7a-chapter-menu");
  await page.getByRole("menuitem", { name: "Remove break" }).click();
  await page.getByText("Chapter break removed. u undoes.").waitFor();
  await waitForCount(page.locator(".chapter-divider"), 0);
  expect((await seeded.api.loadStory(seeded.storyId)).chapterBreaks).toHaveLength(0);

  await page.keyboard.press("u");
  await page.getByRole("button", { name: "Second" }).waitFor();
  const saved = await seeded.api.loadStory(seeded.storyId);
  expect(saved.chapterBreaks).toHaveLength(1);
  expect(saved.chapterBreaks[0]!.title).toBe("Second");
}, 60_000);

test("case 4: chapter one and a later chapter are renamed in place; Escape cancels", async () => {
  const web = await spawnChapterWeb();
  const seeded = await seedThreeParts(web, "Rename Chapters");
  await seeded.api.createChapterBreak(seeded.storyId, seeded.b, "Second");
  const page = await openStory(web, seeded.storyId, "Rename Chapters");

  await page.getByRole("button", { name: "Chapter One" }).click();
  const title = page.getByRole("textbox", { name: "Chapter title" });
  await title.waitFor();
  await page.keyboard.type("Opening");
  await page.keyboard.press("Enter");
  await waitForCount(title, 0);
  expect((await seeded.api.loadStory(seeded.storyId)).firstChapterTitle).toBe("Opening");

  await page.getByRole("button", { name: "Second" }).click();
  await title.waitFor();
  await page.keyboard.type(" thoughts");
  await page.keyboard.press("Escape");
  await waitForCount(title, 0);
  await page.getByRole("button", { name: "Second", exact: true }).waitFor();
  expect((await seeded.api.loadStory(seeded.storyId)).chapterBreaks[0]!.title).toBe("Second");

  await page.getByRole("button", { name: "Chapter actions" }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await title.waitFor();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Third");
  await page.keyboard.press("Enter");
  await waitForCount(title, 0);
  expect((await seeded.api.loadStory(seeded.storyId)).chapterBreaks[0]!.title).toBe("Third");
}, 60_000);

/** A story `A → B → C` whose first chapter (A, B) is closed by a break. */
async function seedClosedChapter(web: ReadyWeb, title: string) {
  const seeded = await seedThreeParts(web, title);
  const created = await seeded.api.createChapterBreak(seeded.storyId, seeded.b, "Second");
  return { ...seeded, breakId: created.breakId };
}

const summaryCard = (page: Page): Locator => page.getByRole("button", { name: /^Chapter One summary/ });

test("case 5: summarize shows the bar status and Stop, refuses Space, and the card appears when done", async () => {
  const web = await spawnChapterWeb(60);
  const seeded = await seedClosedChapter(web, "Summarize A Chapter");
  const page = await openStory(web, seeded.storyId, "Summarize A Chapter");
  const diagnostics = await collectPageDiagnostics(page);

  await page.getByRole("button", { name: "Chapter actions" }).click();
  await page.getByRole("menuitem", { name: "Summarize Chapter One" }).click();
  await page.getByText("Summarizing Chapter One…").first().waitFor();
  await page.getByRole("button", { name: "Stop", exact: true }).waitFor();
  await screenshot(page, "7a-summary-running");
  await part(page, "C:").click();
  await page.keyboard.press("Space");
  await page.getByText("Summarizing… Esc stops it first.").waitFor();

  await summaryCard(page).waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "Continue" }).waitFor();
  expect(await summaryCard(page).textContent()).toContain("stands in");
  const saved = await seeded.api.loadStory(seeded.storyId);
  expect(saved.nodes.some((node) => node.chapterBreakId === seeded.breakId)).toBeTrue();
  await summaryCard(page).click();
  await screenshot(page, "7a-summary-card");
  await page.waitForTimeout(300);
  expect(diagnostics.consoleErrors).toEqual([]);
  expect(diagnostics.cspViolations).toEqual([]);
}, 90_000);

test("case 6: Esc during a summary stops it; the toast and the saved story agree; a rename right after works", async () => {
  const web = await spawnChapterWeb(400);
  const seeded = await seedClosedChapter(web, "Stop A Summary");
  const page = await openStory(web, seeded.storyId, "Stop A Summary");

  await page.getByRole("button", { name: "Chapter actions" }).click();
  await page.getByRole("menuitem", { name: "Summarize Chapter One" }).click();
  await page.getByRole("button", { name: "Stop", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  const toast = page.getByText(/^Chapter One summary (stopped|completed before stop)\.$/);
  await toast.waitFor();
  const saved = await seeded.api.loadStory(seeded.storyId);
  const exists = saved.nodes.some((node) => node.chapterBreakId === seeded.breakId);
  expect((await toast.textContent())?.includes("completed")).toBe(exists);
  await page.getByRole("button", { name: "Continue" }).waitFor();

  await page.getByRole("button", { name: "Second" }).click();
  await page.getByRole("textbox", { name: "Chapter title" }).waitFor();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.type(" thoughts");
  await page.keyboard.press("Enter");
  expect(await poll(async () => (await seeded.api.loadStory(seeded.storyId)).chapterBreaks[0]!.title === "Second thoughts")).toBeTrue();
}, 90_000);

test("case 7: Edit summary and Ctrl/Cmd+S sets the text", async () => {
  const web = await spawnChapterWeb();
  const seeded = await seedClosedChapter(web, "Edit A Summary");
  await seeded.api.summarizeChapter(seeded.storyId, seeded.breakId);
  const page = await openStory(web, seeded.storyId, "Edit A Summary");

  await summaryCard(page).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const box = page.getByRole("textbox", { name: "Edit Chapter One summary" });
  await box.waitFor();
  expect(await poll(() => box.evaluate((element) => element === document.activeElement))).toBeTrue();
  await box.fill("A and B happened, in short.");
  await page.keyboard.press("ControlOrMeta+s");
  await waitForCount(box, 0);
  await page.getByText("A and B happened, in short.").waitFor();
  const saved = await seeded.api.loadStory(seeded.storyId);
  expect(saved.nodes.find((node) => node.chapterBreakId === seeded.breakId)?.text).toBe("A and B happened, in short.");
}, 90_000);

test("case 8: editing a part above makes the summary stale; Refresh makes it stand in again", async () => {
  const web = await spawnChapterWeb();
  const seeded = await seedClosedChapter(web, "Stale Summary");
  await seeded.api.summarizeChapter(seeded.storyId, seeded.breakId);
  const page = await openStory(web, seeded.storyId, "Stale Summary");
  expect(await summaryCard(page).textContent()).toContain("stands in");

  await part(page, "A:").click();
  await page.keyboard.press("e");
  await page.getByRole("textbox", { name: "Text of part 1" }).fill("A: the opening part, changed.");
  await page.getByRole("button", { name: "Save in place" }).click();
  await waitForCount(page.getByRole("textbox", { name: "Text of part 1" }), 0);
  expect(await poll(async () => ((await summaryCard(page).textContent()) ?? "").includes("Stale"))).toBeTrue();
  await screenshot(page, "7a-summary-stale");

  await summaryCard(page).click();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByText("Chapter One summary refreshed.").first().waitFor({ timeout: 30_000 });
  expect(await poll(async () => ((await summaryCard(page).textContent()) ?? "").includes("stands in"))).toBeTrue();
}, 90_000);

test("case 9: removing a break takes its summary; u brings back the break, its title, and the summary", async () => {
  const web = await spawnChapterWeb();
  const seeded = await seedClosedChapter(web, "Undo With Summary");
  await seeded.api.summarizeChapter(seeded.storyId, seeded.breakId);
  const page = await openStory(web, seeded.storyId, "Undo With Summary");
  await summaryCard(page).waitFor();

  await page.getByRole("button", { name: "Chapter actions" }).click();
  await page.getByRole("menuitem", { name: "Remove break" }).click();
  await waitForCount(summaryCard(page), 0);
  expect((await seeded.api.loadStory(seeded.storyId)).nodes.some((node) => node.chapterBreakId !== undefined)).toBeFalse();

  await page.keyboard.press("u");
  await summaryCard(page).waitFor();
  await page.getByRole("button", { name: "Second" }).waitFor();
  const saved = await seeded.api.loadStory(seeded.storyId);
  expect(saved.chapterBreaks[0]!.title).toBe("Second");
  expect(saved.nodes.some((node) => node.chapterBreakId === saved.chapterBreaks[0]!.id)).toBeTrue();
}, 90_000);
