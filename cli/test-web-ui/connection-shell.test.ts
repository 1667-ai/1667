import { afterEach, expect, test } from "bun:test";
import type { Browser } from "playwright-core";
import { cleanupWebProcesses, scratchProject, spawnWeb } from "../test/web-e2e-fixture.js";
import {
  afterAllHook,
  cleanupWebUiPages,
  collectPageDiagnostics,
  launchChrome,
  openInspectionApi,
  openTestPage
} from "./web-ui-fixture.js";

/**
 * The React shell in a real browser (#409 step 3): connection screens, the
 * design system, and the bundled fonts. Cases 4–9 (the Library's own
 * create/rename/delete/search interactions) are `library-crud.test.ts`,
 * added with step 4. Locators are by role and accessible name — never a CSS
 * class, which the design is free to rename.
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

test("case 1: the printed URL shows the Library and the project label; "
  + "the address bar loses #token; there are no CSP violations", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const page = await openTestPage(await sharedBrowser());
  const diagnostics = await collectPageDiagnostics(page);

  await page.goto(web.url);
  await page.getByRole("button", { name: "New story" }).waitFor();
  expect(page.url()).not.toContain("token=");
  await page.getByTitle(web.projectRoot).waitFor();

  // Give any async CSP report / console error time to arrive.
  await page.waitForTimeout(300);
  expect(diagnostics.cspViolations).toEqual([]);
  expect(diagnostics.consoleErrors).toEqual([]);
}, 30_000);

test("case 2: the bundled prose font loads and renders", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const api = await openInspectionApi(web);
  const created = await api.createStory("Font check");

  const page = await openTestPage(await sharedBrowser());
  await page.goto(web.url);
  await page.getByRole("button", { name: "New story" }).waitFor();

  await page.evaluate((id) => {
    location.hash = `#/story/${id}`;
  }, created.id);
  const empty = page.getByText("This story has no text yet.");
  await empty.waitFor();
  await page.evaluate(() => document.fonts.ready);

  const loaded = await page.evaluate(
    () => document.fonts.check('16px "Newsreader Variable"')
  );
  expect(loaded).toBeTrue();
  const fontFamily = await empty.evaluate((element) => getComputedStyle(element).fontFamily);
  expect(fontFamily).toContain("Newsreader");
}, 30_000);

test("case 3: no token in the fragment or storage shows the Locked screen", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const page = await openTestPage(await sharedBrowser());

  await page.goto(web.origin);
  await page.getByText("Open the address that 1667 web printed in the terminal.").waitFor();
}, 30_000);

test("case 10: theme follows the OS by default; the toggle sets an explicit override", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const page = await openTestPage(await sharedBrowser(), { colorScheme: "dark" });

  await page.goto(web.url);
  await page.getByRole("button", { name: "New story" }).waitFor();

  expect(await page.evaluate(() => document.documentElement.getAttribute("data-theme"))).toBeNull();
  // `--bg` for the default "ink" palette in dark mode: #131318.
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor))
    .toBe("rgb(19, 19, 24)");

  await page.getByRole("button", { name: "Toggle light / dark" }).click();

  expect(await page.evaluate(() => document.documentElement.getAttribute("data-theme"))).toBe("light");
  // The light branch of the same token: #f7f8fa.
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor))
    .toBe("rgb(247, 248, 250)");
}, 30_000);

test("case 11: killing the backend shows the Closed overlay with a Reconnect button", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const page = await openTestPage(await sharedBrowser());

  await page.goto(web.url);
  await page.getByRole("button", { name: "New story" }).waitFor();

  web.child.kill("SIGKILL");

  await page.getByText("The connection to 1667 closed.").waitFor();
  await page.getByRole("button", { name: "Reconnect" }).waitFor();
}, 30_000);
