import { afterEach, expect, test } from "bun:test";
import type { Browser, Locator, Page } from "playwright-core";
import { DRY_RUN_WORD_DELAY_VARIABLE } from "../../server/providers.js";
import { cleanupWebProcesses, scratchProject, spawnWeb, type ReadyWeb, type ScratchProject } from "../test/web-e2e-fixture.js";
import {
  afterAllHook,
  cleanupWebUiPages,
  collectPageDiagnostics,
  launchChrome,
  openInspectionApi,
  openTestPage
} from "./web-ui-fixture.js";

/**
 * The writing loop in a real browser (#409 step 6): the composer, retake,
 * and their keys. The dry-run provider is sped up by
 * `AI_1667_DRY_RUN_WORD_DELAY_MS`. Locators use roles and accessible names.
 * Every case that changes the story checks the SAVED story through a second
 * connection, not only what is on screen.
 */

const WORD_DELAY_MS = 20;

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

async function spawnComposeWeb(project: ScratchProject): Promise<ReadyWeb> {
  return await spawnWeb(
    ["--data", project.dataDir, "--port", "0", "--no-open"],
    { ...project.env, [DRY_RUN_WORD_DELAY_VARIABLE]: String(WORD_DELAY_MS) }
  );
}

async function openStoryPage(page: Page, web: ReadyWeb, storyId: string): Promise<void> {
  await page.goto(web.url);
  await page.getByRole("button", { name: "New story" }).waitFor();
  await page.evaluate((id) => { location.hash = `#/story/${id}`; }, storyId);
}

function part(page: Page, text: string): Locator {
  return page.locator(".part").filter({ hasText: text });
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
  const ok = await poll(async () => (await locator.count()) === count, timeoutMs);
  expect(ok).toBeTrue();
}

async function waitForAttribute(locator: Locator, name: string, value: string): Promise<void> {
  const ok = await poll(async () => (await locator.getAttribute(name)) === value);
  expect(ok).toBeTrue();
}

function continueButton(page: Page): Locator {
  return page.getByRole("button", { name: "Continue" });
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

test("case 1: r on a middle part streams a new take in its place, hides the old take and what follows, and lands as take 2 of 2", async () => {
  const project = await scratchProject();
  const web = await spawnComposeWeb(project);
  const seeded = await seedThreeParts(web, "Retake Story");

  const page = await openTestPage(await sharedBrowser());
  const diagnostics = await collectPageDiagnostics(page);
  await openStoryPage(page, web, seeded.storyId);
  await page.getByRole("heading", { name: "Retake Story" }).waitFor();
  await waitForCount(page.locator(".part"), 3);

  await part(page, "B:").click();
  await waitForAttribute(part(page, "B:"), "aria-current", "true");
  await page.keyboard.press("r");

  await waitForCount(page.locator(".part-streaming"), 1);
  await waitForCount(part(page, "C:"), 0);
  await waitForCount(part(page, "B:"), 0);
  expect(await page.locator(".part-streaming .part-number").textContent()).toBe("PART 2");

  await waitForCount(page.locator(".part-streaming"), 0, 10_000);
  await waitForCount(page.locator(".part"), 2);
  const landed = page.locator(".part").nth(1);
  await waitForAttribute(landed, "aria-current", "true");
  expect(await landed.locator(".label-chip").textContent()).toContain("×2");

  const saved = await seeded.api.loadStory(seeded.storyId);
  expect(saved.path.map((node) => node.parentId)).toEqual([null, seeded.a]);
  expect(saved.path[1]!.id).not.toBe(seeded.b);
  expect(saved.path[1]!.text).toContain("dry-run text");
  expect(saved.nodes.filter((node) => node.parentId === seeded.a)).toHaveLength(2);
  expect(await continueButton(page).count()).toBe(1);

  await page.waitForTimeout(300);
  expect(diagnostics.consoleErrors).toEqual([]);
  expect(diagnostics.cspViolations).toEqual([]);
}, 60_000);
