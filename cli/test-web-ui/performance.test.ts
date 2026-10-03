import { afterEach, expect, test } from "bun:test";
import type { Browser } from "playwright-core";
import { cleanupWebProcesses, scratchProject, spawnWeb } from "../test/web-e2e-fixture.js";
import {
  afterAllHook,
  cleanupWebUiPages,
  launchChrome,
  openInspectionApi,
  openTestPage
} from "./web-ui-fixture.js";
import { seedLargeStory } from "./map-fixture.js";

/**
 * Responsiveness on a large story (#409). Only cheap in-page probes read the
 * page here: a role query walks the whole accessibility tree of a page with
 * thousands of elements, and that alone would block the main thread.
 */

/** No single main-thread task may freeze the page this long while a reader
 * holds the arrow key. A quiet machine sees no long task at all; the budget
 * leaves a wide margin for a loaded CI machine. */
const LONG_TASK_BUDGET_MS = 250;
const KEY_PRESSES = 30;

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

test("holding ↓ through a large story never freezes the page", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const api = await openInspectionApi(web);
  const seeded = await seedLargeStory(api);

  const page = await openTestPage(await sharedBrowser());
  await page.goto(web.url);
  await page.getByRole("button", { name: "New story" }).waitFor();
  await page.evaluate((id) => { location.hash = `#/story/${id}`; }, seeded.storyId);
  await page.locator(".part").first().waitFor({ timeout: 60_000 });
  await page.evaluate(() => {
    const seen: number[] = [];
    (window as unknown as { __longTasks: number[] }).__longTasks = seen;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) seen.push(entry.duration);
    }).observe({ type: "longtask" });
    (document.querySelector(".part") as HTMLElement).focus();
  });
  await page.keyboard.press("g");
  // Let the open settle, so only the key presses are measured.
  await page.waitForTimeout(1_500);
  await page.evaluate(() => { (window as unknown as { __longTasks: number[] }).__longTasks.length = 0; });

  const partNumber = (): Promise<number> => page.evaluate(
    () => Number(/Part (\d+)/.exec(document.activeElement?.getAttribute("aria-label") ?? "")?.[1] ?? 0)
  );
  const start = await partNumber();
  for (let i = 0; i < KEY_PRESSES; i += 1) {
    await page.keyboard.down("ArrowDown");
    await page.waitForTimeout(33);
  }
  await page.keyboard.up("ArrowDown");
  await page.waitForTimeout(500);

  expect(await partNumber()).toBe(start + KEY_PRESSES);
  const longest = await page.evaluate(
    () => Math.max(0, ...(window as unknown as { __longTasks: number[] }).__longTasks)
  );
  expect(longest < LONG_TASK_BUDGET_MS).toBeTrue();
}, 120_000);
