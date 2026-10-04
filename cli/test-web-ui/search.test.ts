import { afterEach, expect, test } from "bun:test";
import type { Browser, Locator, Page } from "playwright-core";
import { cleanupWebProcesses, scratchProject, spawnWeb, type ReadyWeb } from "../test/web-e2e-fixture.js";
import {
  afterAllHook,
  cleanupWebUiPages,
  launchChrome,
  openInspectionApi,
  openTestPage,
  seedForkedStory
} from "./web-ui-fixture.js";

/**
 * Full-text search (`/`) in a real browser (#409 step 10c): scopes, groups,
 * the case toggle, opening a hit, Fact hits and the minimum query length.
 * Locators use roles and accessible names.
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

/** Saves a screenshot as `web-<name>.png` into the directory named by
 * `AI_1667_WEB_UI_SCREENSHOTS`; does nothing when it is not set. */
async function screenshot(page: Page, name: string): Promise<void> {
  const dir = process.env.AI_1667_WEB_UI_SCREENSHOTS;
  if (dir === undefined) return;
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${dir}/web-${name}.png` });
}

async function spawnSearchWeb(): Promise<ReadyWeb> {
  const project = await scratchProject();
  return await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
}

async function openStory(
  web: ReadyWeb,
  storyId: string,
  title: string,
  beforeGoto: (page: Page) => void = () => {}
): Promise<Page> {
  const page = await openTestPage(await sharedBrowser());
  beforeGoto(page);
  await page.goto(web.url);
  await page.getByRole("button", { name: "New story" }).waitFor();
  await page.evaluate((id) => { location.hash = `#/story/${id}`; }, storyId);
  await page.getByRole("heading", { name: title }).waitFor();
  return page;
}

const dialog = (page: Page): Locator => page.getByRole("dialog", { name: "Search" });
const options = (page: Page): Locator => dialog(page).getByRole("option");
const status = (page: Page): Locator => dialog(page).getByRole("status");

async function openSearch(page: Page): Promise<void> {
  await page.locator(".part").first().click();
  await page.keyboard.press("/");
  await dialog(page).waitFor();
}

/** The text of the part that holds keyboard focus, or `null`. */
async function focusedPartText(page: Page): Promise<string | null> {
  return await page.evaluate(() => document.activeElement?.closest(".part")?.textContent ?? null);
}

test("case 1: a word in an unchosen take shows under a dead-branch group; Enter switches to that line and focuses the part", async () => {
  const web = await spawnSearchWeb();
  const api = await openInspectionApi(web);
  const seeded = await seedForkedStory(api);
  const page = await openStory(web, seeded.storyId, "Forked Story");
  await openSearch(page);

  await page.keyboard.type("take");
  await status(page).filter({ hasText: "3 hits" }).waitFor();
  // The current line first, then the dead branches by their fork.
  const groups = options(page).filter({ hasText: /this line|dead branch/ });
  expect(await groups.count()).toBe(3);
  expect(await groups.nth(0).textContent()).toContain("this line");
  expect(await groups.nth(1).textContent()).toContain("dead branch");
  await screenshot(page, "10c-search");

  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("a second take");
  await status(page).filter({ hasText: "1 hit" }).waitFor();
  expect(await options(page).filter({ hasText: "dead branch" }).count()).toBe(1);
  expect(await dialog(page).getByLabel("Preview").textContent()).toContain("B2: a second take of the same part as B1.");
  await page.keyboard.press("Enter");

  await dialog(page).waitFor({ state: "detached" });
  expect(await poll(async () => (await focusedPartText(page))?.includes("B2:") === true)).toBeTrue();
  expect(await page.locator(".part").count()).toBe(3);
  expect(await page.locator(".part").nth(2).textContent()).toContain("C2:");
});

test("case 2: Tab to all stories shows a hit in a second story; Enter opens that story with the part focused", async () => {
  const web = await spawnSearchWeb();
  const api = await openInspectionApi(web);
  const first = await api.createStory("First Story");
  await api.createNode(first.id, { text: "The first story is about a lighthouse.", parentId: null });
  const second = await api.createStory("Second Story");
  const opening = await api.createNode(second.id, { text: "Second story opening.", parentId: null });
  await api.createNode(second.id, { text: "The keeper climbed the zeppelin ladder.", parentId: opening.path.at(-1)!.id });
  const page = await openStory(web, first.id, "First Story");
  await openSearch(page);

  await page.keyboard.type("zeppelin");
  await status(page).filter({ hasText: "No matches." }).waitFor();
  await page.keyboard.press("Tab");
  await options(page).filter({ hasText: "Second Story" }).waitFor();
  expect(await dialog(page).getByRole("button", { name: "All stories" }).getAttribute("aria-pressed")).toBe("true");
  await screenshot(page, "10c-vault");
  await options(page).filter({ hasText: "zeppelin" }).waitFor();
  await page.keyboard.press("Enter");

  await dialog(page).waitFor({ state: "detached" });
  expect(await poll(async () => page.url().endsWith(`#/story/${second.id}`))).toBeTrue();
  expect(await poll(async () => (await focusedPartText(page))?.includes("zeppelin") === true)).toBeTrue();
});

test("case 3: the Aa toggle and Ctrl+S change the hit count for Anna against anna", async () => {
  const web = await spawnSearchWeb();
  const api = await openInspectionApi(web);
  const created = await api.createStory("Case Story");
  const first = await api.createNode(created.id, { text: "Anna smiled at the gate.", parentId: null });
  await api.createNode(created.id, { text: "Later anna waved from the boat.", parentId: first.path.at(-1)!.id });
  const page = await openStory(web, created.id, "Case Story");
  await openSearch(page);

  await page.keyboard.type("Anna");
  await status(page).filter({ hasText: "2 hits" }).waitFor();
  const toggle = dialog(page).getByRole("button", { name: "Match case" });
  expect(await toggle.getAttribute("aria-pressed")).toBe("false");
  await toggle.click();
  await status(page).filter({ hasText: "1 hit" }).waitFor();
  expect(await toggle.getAttribute("aria-pressed")).toBe("true");

  await page.getByRole("combobox", { name: "Search text" }).focus();
  await page.keyboard.press("Control+s");
  await status(page).filter({ hasText: "2 hits" }).waitFor();
  expect(await toggle.getAttribute("aria-pressed")).toBe("false");
});

test("case 4: a Fact hit opens the Facts panel on that Fact and its state", async () => {
  const web = await spawnSearchWeb();
  const api = await openInspectionApi(web);
  const created = await api.createStory("Fact Story");
  const first = await api.createNode(created.id, { text: "Nothing happens at the door.", parentId: null });
  const made = await api.createFact(created.id, { name: "The door", text: "The door is open." });
  const factId = made.facts.find((fact) => fact.name === "The door")!.id;
  await api.createFactState!(created.id, factId, { text: "The door is bolted shut.", anchorPartId: first.path.at(-1)!.id });
  const page = await openStory(web, created.id, "Fact Story");
  await openSearch(page);

  await page.keyboard.type("bolted");
  await options(page).filter({ hasText: "bolted" }).waitFor();
  expect(await options(page).filter({ hasText: "canon notes" }).count()).toBe(1);
  await page.keyboard.press("Enter");

  await dialog(page).waitFor({ state: "detached" });
  const panel = page.getByRole("complementary", { name: "Facts" });
  await panel.waitFor();
  const form = panel.getByRole("form", { name: "Edit fact" });
  await form.waitFor();
  expect(await form.getByRole("textbox", { name: "Name" }).inputValue()).toBe("The door");
  expect(await form.getByRole("textbox", { name: "Text" }).inputValue()).toBe("The door is bolted shut.");
});

test("case 5: a one-character query sends no request and shows the hint; Esc puts focus back", async () => {
  const web = await spawnSearchWeb();
  const api = await openInspectionApi(web);
  const seeded = await seedForkedStory(api);
  let requests = 0;
  const page = await openStory(web, seeded.storyId, "Forked Story", (opened) => {
    opened.on("websocket", (socket) => {
      socket.on("framesent", (frame) => {
        if (String(frame.payload).includes("searchStories")) requests += 1;
      });
    });
  });
  await page.locator(".part").nth(1).click();
  await page.keyboard.press("/");
  await dialog(page).waitFor();

  await page.keyboard.type("B");
  await status(page).filter({ hasText: "Type at least 2 characters" }).waitFor();
  await page.waitForTimeout(500);
  expect(requests).toBe(0);
  expect(await options(page).count()).toBe(0);

  await page.keyboard.type("1");
  await status(page).filter({ hasText: "3 hits" }).waitFor();
  expect(requests).toBe(1);

  await page.keyboard.press("Escape");
  await dialog(page).waitFor({ state: "detached" });
  expect(await poll(async () => (await focusedPartText(page))?.includes("B1:") === true)).toBeTrue();
});
