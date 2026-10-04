import { afterEach, expect, test } from "bun:test";
import type { Browser, Locator, Page } from "playwright-core";
import { cleanupWebProcesses, scratchProject, spawnWeb, type ReadyWeb } from "../test/web-e2e-fixture.js";
import {
  afterAllHook,
  cleanupWebUiPages,
  collectPageDiagnostics,
  launchChrome,
  openInspectionApi,
  openTestPage,
  seedForkedStory,
  type ForkedStory
} from "./web-ui-fixture.js";

/**
 * The Fact consistency check in a real browser (#409 step 10h): the palette
 * commands, the confirmation, the run lock, and the panel's Findings view.
 * Every case checks the SAVED story through a second connection.
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

async function poll(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    if (await check()) return true;
    if (Date.now() - start > timeoutMs) return await check();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function screenshot(page: Page, name: string): Promise<void> {
  const dir = process.env.AI_1667_WEB_UI_SCREENSHOTS;
  if (dir === undefined) return;
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${dir}/web-${name}.png` });
}

async function spawnCheckWeb(): Promise<ReadyWeb> {
  const project = await scratchProject();
  return await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
}

type Api = Awaited<ReturnType<typeof openInspectionApi>>;

/** The forked story, with a story-wide Fact when `withFact` is true. */
async function seed(web: ReadyWeb, withFact: boolean): Promise<ForkedStory & { api: Api }> {
  const api = await openInspectionApi(web);
  const story = await seedForkedStory(api);
  if (withFact) await api.createFact(story.storyId, { name: "Mara", text: "Mara keeps the light." });
  return { ...story, api };
}

async function openStory(web: ReadyWeb, storyId: string, route: (page: Page) => Promise<void> = async () => {}): Promise<Page> {
  const page = await openTestPage(await sharedBrowser(), { viewport: { width: 1400, height: 900 } });
  await route(page);
  await page.goto(web.url);
  await page.getByRole("button", { name: "New story" }).waitFor();
  await page.evaluate((id) => { location.hash = `#/story/${id}`; }, storyId);
  await page.getByRole("heading", { name: "Forked Story" }).waitFor();
  return page;
}

const part = (page: Page, text: string): Locator => page.locator(".part").filter({ hasText: text });
const palette = (page: Page): Locator => page.getByRole("dialog", { name: "Command palette" });
const findingsPanel = (page: Page): Locator => page.getByRole("complementary", { name: "Findings" });
const findingRows = (page: Page): Locator => findingsPanel(page).getByRole("list", { name: "Findings" }).getByRole("listitem");

async function runCommand(page: Page, query: string): Promise<void> {
  await part(page, "C1:").click();
  await page.keyboard.press(":");
  await palette(page).waitFor();
  await page.keyboard.type(query);
  await page.keyboard.press("Enter");
  await palette(page).waitFor({ state: "detached" });
}

test("case 1: the plan shows the part and request counts; Cancel runs nothing", async () => {
  const web = await spawnCheckWeb();
  const seeded = await seed(web, true);
  const page = await openStory(web, seeded.storyId);
  const diagnostics = await collectPageDiagnostics(page);

  await runCommand(page, "check chapter");
  const dialog = page.getByRole("dialog", { name: "Check chapter against Facts" });
  await dialog.waitFor();
  await dialog.getByText(/reads 3 parts and sends 3 requests/).waitFor();
  await screenshot(page, "10h-confirm");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await dialog.waitFor({ state: "detached" });

  expect(await seeded.api.getFactConsistencyRun!(seeded.storyId)).toBeNull();
  expect(await findingsPanel(page).count()).toBe(0);
  expect(diagnostics.consoleErrors).toEqual([]);
  expect(diagnostics.cspViolations).toEqual([]);
}, 90_000);

test("case 2: Confirm runs the check; clicking a finding focuses its part", async () => {
  const web = await spawnCheckWeb();
  const seeded = await seed(web, true);
  const page = await openStory(web, seeded.storyId);

  await runCommand(page, "check story line");
  const dialog = page.getByRole("dialog", { name: "Check story line against Facts" });
  await dialog.getByRole("button", { name: "Check" }).click();
  await findingsPanel(page).waitFor();
  await findingRows(page).first().waitFor();
  expect(await findingRows(page).count()).toBe(3);
  const first = findingRows(page).first();
  expect(await first.textContent()).toContain("Mara");
  expect(await first.textContent()).toContain("A1: the opening part of the story");
  expect(await first.textContent()).toContain("Dry-run placeholder.");
  await screenshot(page, "10h-findings");

  const run = await seeded.api.getFactConsistencyRun!(seeded.storyId);
  expect(run?.scope).toBe("story-line");
  expect(run?.parts.flatMap((p) => p.findings)).toHaveLength(3);

  await first.click();
  expect(await poll(async () => (await part(page, "A1:").getAttribute("aria-current")) === "true")).toBeTrue();
  await findingRows(page).nth(1).click();
  expect(await poll(async () => (await part(page, "B1:").getAttribute("aria-current")) === "true")).toBeTrue();
}, 90_000);

test("case 3: after a reload, show Fact findings is under Suggested and opens the last run", async () => {
  const web = await spawnCheckWeb();
  const seeded = await seed(web, true);
  const first = await openStory(web, seeded.storyId);
  await runCommand(first, "check chapter");
  await first.getByRole("dialog", { name: "Check chapter against Facts" }).getByRole("button", { name: "Check" }).click();
  await findingRows(first).first().waitFor();

  const page = await openStory(web, seeded.storyId);
  expect(await findingsPanel(page).count()).toBe(0);
  await part(page, "C1:").click();
  await page.keyboard.press(":");
  await palette(page).waitFor();
  const suggested = palette(page).getByRole("group", { name: "Suggested" });
  const option = suggested.getByRole("option").first();
  expect(await option.textContent()).toContain("show Fact findings");
  await page.keyboard.press("Enter");
  await findingRows(page).first().waitFor();
  expect(await findingRows(page).count()).toBe(3);
}, 90_000);

test("case 4: while the check runs, Continue is refused", async () => {
  const web = await spawnCheckWeb();
  const seeded = await seed(web, true);
  // Holds the check's request until the test lets it through.
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let sent = false;
  const page = await openStory(web, seeded.storyId, async (target) => {
    await target.routeWebSocket(/\/bridge/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((message) => {
        if (typeof message === "string" && message.includes("\"checkFactConsistency\"")) {
          sent = true;
          void held.then(() => server.send(message));
        } else server.send(message);
      });
      server.onMessage((message) => ws.send(message));
    });
  });

  await runCommand(page, "check chapter");
  await page.getByRole("dialog", { name: "Check chapter against Facts" }).getByRole("button", { name: "Check" }).click();
  expect(await poll(async () => sent)).toBeTrue();

  await part(page, "C1:").click();
  await page.keyboard.press("Space");
  await page.getByText("Checking Facts… Wait for it.").first().waitFor();
  expect(await page.getByRole("button", { name: "Stop" }).count()).toBe(0);

  release();
  await findingRows(page).first().waitFor();
  const story = await seeded.api.loadStory(seeded.storyId);
  expect(story.path.map((node) => node.id)).toEqual([seeded.a1, seeded.b1, seeded.c1]);
}, 90_000);

test("case 5: a story with no Facts does not offer the check commands", async () => {
  const web = await spawnCheckWeb();
  const seeded = await seed(web, false);
  const page = await openStory(web, seeded.storyId);

  await part(page, "C1:").click();
  await page.keyboard.press(":");
  await palette(page).waitFor();
  await page.keyboard.type("against Facts");
  expect(await palette(page).getByRole("option").count()).toBe(0);
  await page.keyboard.press("Escape");
  await palette(page).waitFor({ state: "detached" });

  await seeded.api.createFact(seeded.storyId, { name: "Mara", text: "Mara keeps the light." });
  await page.reload();
  await page.getByRole("heading", { name: "Forked Story" }).waitFor();
  await part(page, "C1:").click();
  await page.keyboard.press(":");
  await palette(page).waitFor();
  await page.keyboard.type("against Facts");
  expect(await palette(page).getByRole("option").count()).toBe(2);
}, 90_000);

test("case 6: a finding whose part was deleted shows as out of date and Findings does not crash", async () => {
  const web = await spawnCheckWeb();
  const seeded = await seed(web, true);
  const first = await openStory(web, seeded.storyId);
  await runCommand(first, "check story line");
  await first.getByRole("dialog", { name: "Check story line against Facts" }).getByRole("button", { name: "Check" }).click();
  await findingRows(first).first().waitFor();

  await seeded.api.loadStory(seeded.storyId);
  await seeded.api.deleteNode(seeded.storyId, seeded.c1, 1);
  const page = await openStory(web, seeded.storyId);
  const diagnostics = await collectPageDiagnostics(page);
  await part(page, "B1:").click();
  await page.keyboard.press(":");
  await palette(page).waitFor();
  await page.keyboard.type("show Fact findings");
  await page.keyboard.press("Enter");
  await findingRows(page).first().waitFor();
  expect(await findingRows(page).count()).toBe(3);
  expect(await findingsPanel(page).getByText("Out of date").count()).toBe(1);
  expect(diagnostics.consoleErrors).toEqual([]);
}, 90_000);
