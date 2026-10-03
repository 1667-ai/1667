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
 * Line tags in a real browser (#409 step 7a): the header chip, the `t` key,
 * the tag popover, and the tagged-lines list. Every case checks the SAVED
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

async function spawnTagWeb(wordDelayMs = 20): Promise<ReadyWeb> {
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

const chip = (page: Page): Locator => page.getByRole("button", { name: "Tag line (t)" });
const popover = (page: Page): Locator => page.getByRole("dialog", { name: "Tag line" });
const nameField = (page: Page): Locator => popover(page).getByRole("textbox", { name: "Name" });

test("case 1: t tags the line with a status; the chip, the popover, and the saved story agree", async () => {
  const web = await spawnTagWeb();
  const seeded = await seedThreeParts(web, "Tag A Line");
  const page = await openStory(web, seeded.storyId, "Tag A Line");
  const diagnostics = await collectPageDiagnostics(page);
  await part(page, "B:").click();
  await waitForAttribute(part(page, "B:"), "aria-current", "true");

  await page.keyboard.press("t");
  await popover(page).waitFor();
  expect(await poll(() => nameField(page).evaluate((element) => element === document.activeElement))).toBeTrue();
  await page.keyboard.type("The long road");
  await popover(page).getByRole("radio", { name: "Canon" }).click();
  await screenshot(page, "7a-tag-popover");
  await page.keyboard.press("Enter");

  await waitForCount(popover(page), 0);
  expect(await chip(page).textContent()).toContain("The long road");
  expect(await chip(page).textContent()).toContain("Canon");
  const saved = await seeded.api.loadStory(seeded.storyId);
  expect(saved.tags).toHaveLength(1);
  expect(saved.tags[0]!.nodeId).toBe(seeded.c);
  expect(saved.tags[0]!.name).toBe("The long road");
  expect(saved.tags[0]!.status).toBe("Canon");
  // The keyboard goes back to the part, so the next key still reads.
  expect(await poll(() => part(page, "B:").evaluate((element) => element === document.activeElement))).toBeTrue();
  await page.waitForTimeout(300);
  expect(diagnostics.consoleErrors).toEqual([]);
  expect(diagnostics.cspViolations).toEqual([]);
}, 60_000);

test("case 2: a tagged line opens prefilled; the status changes; Remove deletes the tag", async () => {
  const web = await spawnTagWeb();
  const seeded = await seedThreeParts(web, "Retag A Line");
  await seeded.api.putBookmark(seeded.storyId, seeded.c, "First pass", "Draft");
  const page = await openStory(web, seeded.storyId, "Retag A Line");

  await chip(page).click();
  await popover(page).waitFor();
  expect(await nameField(page).inputValue()).toBe("First pass");
  expect(await popover(page).getByRole("radio", { name: "Draft" }).getAttribute("aria-checked")).toBe("true");
  await popover(page).getByRole("radio", { name: "Alt" }).click();
  await popover(page).getByRole("button", { name: "Save" }).click();
  await waitForCount(popover(page), 0);
  expect((await seeded.api.loadStory(seeded.storyId)).tags[0]!.status).toBe("Alt");
  expect(await chip(page).textContent()).toContain("Alt");

  await chip(page).click();
  await popover(page).getByRole("button", { name: "Remove" }).click();
  await waitForCount(popover(page), 0);
  expect((await seeded.api.loadStory(seeded.storyId)).tags).toHaveLength(0);
  expect(await chip(page).textContent()).not.toContain("Alt");
}, 60_000);

test("case 3: the tagged-lines list marks the current line and deletes a tag after two clicks", async () => {
  const web = await spawnTagWeb();
  const seeded = await seedThreeParts(web, "Tagged Lines");
  const other = await seeded.api.createNode(seeded.storyId, { text: "C2: another ending.", parentId: seeded.b });
  const otherLeaf = other.path.at(-1)!.id;
  await seeded.api.putBookmark(seeded.storyId, otherLeaf, "Other ending", "Alt");
  await seeded.api.switchLine(seeded.storyId, seeded.c);
  await seeded.api.putBookmark(seeded.storyId, seeded.c, "Main ending", "Canon");
  const page = await openStory(web, seeded.storyId, "Tagged Lines");

  await chip(page).click();
  const rows = popover(page).getByRole("listitem");
  await waitForCount(rows, 2);
  expect(await popover(page).textContent()).toContain("Tagged lines (2)");
  expect(await rows.filter({ hasText: "Main ending" }).getAttribute("class")).toContain("current");
  await screenshot(page, "7a-tag-list");

  const row = rows.filter({ hasText: "Other ending" });
  await row.getByRole("button", { name: "Delete tag" }).click();
  expect((await seeded.api.loadStory(seeded.storyId)).tags).toHaveLength(2);
  await row.getByRole("button", { name: "Confirm" }).click();
  await waitForCount(rows, 1);
  const saved = await seeded.api.loadStory(seeded.storyId);
  expect(saved.tags.map((tag) => tag.name)).toEqual(["Main ending"]);
}, 60_000);

test("case 4: Escape closes the popover and keeps the draft and a background run; a save waits for the run", async () => {
  const web = await spawnTagWeb(60);
  const seeded = await seedThreeParts(web, "Tag While Writing");
  const page = await openStory(web, seeded.storyId, "Tag While Writing");
  await part(page, "C:").click();
  await waitForAttribute(part(page, "C:"), "aria-current", "true");

  await page.keyboard.press("Space");
  await page.getByRole("button", { name: "Stop" }).waitFor();
  await page.keyboard.press("t");
  await popover(page).waitFor();
  await page.keyboard.type("Half a name");
  await page.keyboard.press("Escape");
  await waitForCount(popover(page), 0);
  expect(await page.getByRole("button", { name: "Stop" }).count()).toBe(1);

  await chip(page).click();
  expect(await nameField(page).inputValue()).toBe("Half a name");
  await popover(page).getByRole("button", { name: "Save" }).click();
  await page.getByText("Writing… Esc stops it first. Draft kept.").waitFor();
  expect(await popover(page).count()).toBe(1);
  expect(await nameField(page).inputValue()).toBe("Half a name");
  expect((await seeded.api.loadStory(seeded.storyId)).tags).toHaveLength(0);

  await page.getByRole("button", { name: "Stop" }).click();
  await page.getByRole("button", { name: "Continue" }).waitFor();
  // Pressing Stop is an outside press: the popover closed, the draft stayed.
  await chip(page).click();
  expect(await nameField(page).inputValue()).toBe("Half a name");
  await popover(page).getByRole("button", { name: "Save" }).click();
  await waitForCount(popover(page), 0);
  const saved = await seeded.api.loadStory(seeded.storyId);
  expect(saved.tags).toHaveLength(1);
  expect(saved.tags[0]!.name).toBe("Half a name");
}, 90_000);

test("case 5: the part menu has Tag line (t), and it opens the popover", async () => {
  const web = await spawnTagWeb();
  const seeded = await seedThreeParts(web, "Tag From Menu");
  const page = await openStory(web, seeded.storyId, "Tag From Menu");
  await part(page, "B:").getByRole("button", { name: "Part actions (x)" }).click();
  const item = page.getByRole("menu", { name: "Actions for part 2" }).getByRole("menuitem", { name: /^Tag line/ });
  expect(await item.getAttribute("title")).toBe("Tag line (t)");
  await item.click();
  await popover(page).waitFor();
  await page.keyboard.type("From the menu");
  await page.keyboard.press("Enter");
  await waitForCount(popover(page), 0);
  expect((await seeded.api.loadStory(seeded.storyId)).tags[0]!.name).toBe("From the menu");
}, 60_000);
