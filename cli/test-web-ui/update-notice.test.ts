import { afterEach, expect, test } from "bun:test";
import type { Browser, Page } from "playwright-core";
import { cleanupWebProcesses, scratchProject, spawnWeb } from "../test/web-e2e-fixture.js";
import {
  afterAllHook,
  cleanupWebUiPages,
  collectPageDiagnostics,
  launchChrome,
  openTestPage
} from "./web-ui-fixture.js";

/**
 * The update notice in a real browser (`docs/web.md`): a reader on an
 * outdated build gets one dismissible toast that names the newer version,
 * and the notice log keeps it.
 *
 * `/api/status` is answered by the real server and then given the `update`
 * field a settled check would have put there, because the check reaches
 * `https://registry.npmjs.org` and a browser test must not. The timing is
 * the real one: the first read — the one `client/web-bridge-connect.ts`
 * makes while it connects — reports a check still running, and the answer
 * arrives only on a later read, which is the case a page that read once
 * would miss entirely.
 */

const NOTICE = "1667 99.0.0 available";

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

/** Saves a screenshot as `web-update-<name>.png` into the directory named by
 * `AI_1667_WEB_UI_SCREENSHOTS`; does nothing when it is not set. */
async function screenshot(page: Page, name: string): Promise<void> {
  const dir = process.env.AI_1667_WEB_UI_SCREENSHOTS;
  if (dir === undefined) return;
  await page.screenshot({ path: `${dir}/web-update-${name}.png` });
}

/**
 * Serves the real page, and rewrites only `/api/status`'s `update` field:
 * the first read says a check is running, every later read carries `notice`.
 * Returns how many reads the page has made.
 */
async function pageWithUpdate(
  notice: string | null
): Promise<{ readonly page: Page; reads(): number }> {
  const project = await scratchProject();
  // `scratchProject` turns the real check off, so the only `update` field
  // the page can see is the one this route writes.
  const web = await spawnWeb(
    ["--data", project.dataDir, "--port", "0", "--no-open"],
    project.env
  );
  const page = await openTestPage(await sharedBrowser());
  let reads = 0;
  await page.route("**/api/status", async (route) => {
    const response = await route.fetch();
    const body = await response.json() as Record<string, unknown>;
    reads += 1;
    const update = reads === 1 || notice === null
      ? { pending: notice !== null, notice: null }
      : { pending: false, notice };
    await route.fulfill({ response, json: { ...body, update } });
  });
  await page.goto(web.url);
  await page.getByRole("button", { name: "New story" }).waitFor();
  return { page, reads: () => reads };
}

test("case 1: an outdated build shows one toast that names the newer version, "
  + "the reader can dismiss it, and the notice log keeps it", async () => {
  const { page, reads } = await pageWithUpdate(NOTICE);
  const diagnostics = await collectPageDiagnostics(page);

  const toast = page.locator(".toast").filter({ hasText: NOTICE });
  // The notice arrives only on a read after the one that connected this tab.
  await toast.waitFor({ timeout: 20_000 });
  expect(reads()).toBeGreaterThan(1);
  expect(await toast.textContent()).toContain("99.0.0");
  // Notify only: the toast tells the reader a version exists and offers
  // nothing that installs it.
  expect(await toast.getByRole("button").count()).toBe(1);
  await screenshot(page, "toast");

  await toast.getByRole("button", { name: "Dismiss" }).click();
  await toast.waitFor({ state: "detached" });

  await page.keyboard.press("!");
  const log = page.getByRole("dialog", { name: "Notice log" });
  await log.waitFor();
  const row = log.getByRole("listitem").filter({ hasText: NOTICE });
  expect(await row.count()).toBe(1);
  await screenshot(page, "log");
  await page.keyboard.press("Escape");
  await log.waitFor({ state: "detached" });

  expect(diagnostics.cspViolations).toEqual([]);
  expect(diagnostics.consoleErrors).toEqual([]);
}, 60_000);

test("case 2: a run with no update shows no toast, and stops asking", async () => {
  const { page, reads } = await pageWithUpdate(null);

  // Long enough for the first re-read to have come and gone.
  await page.waitForTimeout(8_000);
  expect(await page.locator(".toast").count()).toBe(0);
  await page.keyboard.press("!");
  const log = page.getByRole("dialog", { name: "Notice log" });
  await log.waitFor();
  expect(await log.getByRole("listitem").filter({ hasText: "available" }).count()).toBe(0);
  // A settled answer ends the watch: the connect read, and nothing after it.
  expect(reads()).toBe(1);
}, 60_000);
