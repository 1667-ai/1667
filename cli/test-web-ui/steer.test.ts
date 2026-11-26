import { afterEach, expect, test } from "bun:test";
import type { Browser, Locator, Page } from "playwright-core";
import { DRY_RUN_WORD_DELAY_VARIABLE } from "../../server/providers.js";
import { cleanupWebProcesses, scratchProject, spawnWeb, type ReadyWeb } from "../test/web-e2e-fixture.js";
import { afterAllHook, cleanupWebUiPages, launchChrome, openInspectionApi, openTestPage } from "./web-ui-fixture.js";

/**
 * The steer page in a real browser: a continuation previewed word by word
 * against the dry-run provider, scrubbed with the knob, and kept or
 * discarded. Locators use roles and names; the shown words are read from the
 * word spans. Every case also checks the saved story through the inspection
 * API, because "nothing is saved" is the contract of a preview.
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

async function spawnSteerWeb(): Promise<ReadyWeb> {
  const project = await scratchProject();
  return await spawnWeb(
    ["--data", project.dataDir, "--port", "0", "--no-open"],
    { ...project.env, [DRY_RUN_WORD_DELAY_VARIABLE]: String(WORD_DELAY_MS) }
  );
}

async function poll(check: () => Promise<boolean>, timeoutMs = 8_000): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    if (await check()) return true;
    if (Date.now() - start > timeoutMs) return await check();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const knobOf = (page: Page): Locator => page.getByRole("slider", { name: "Continuation knob" });

async function knobValue(page: Page, name: "aria-valuenow" | "aria-valuemax"): Promise<number> {
  return Number(await knobOf(page).getAttribute(name));
}

async function openSteerPage(web: ReadyWeb, storyId: string, title: string): Promise<Page> {
  const page = await openTestPage(await sharedBrowser());
  // The steer page is experimental; case 4 turns it on in Settings.
  await page.addInitScript(() => localStorage.setItem("1667.web.experiment.steer", "1"));
  await page.goto(web.url);
  await page.getByRole("button", { name: "New story" }).waitFor();
  await page.evaluate((id) => { location.hash = `#/story/${id}`; }, storyId);
  await page.getByRole("heading", { name: title }).waitFor();
  await page.locator(".part").first().click();
  await page.keyboard.press(":");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.waitFor();
  await page.keyboard.type("steer");
  expect(await palette.getByRole("option").first().textContent()).toContain("steer");
  await page.keyboard.press("Enter");
  await knobOf(page).waitFor();
  return page;
}

async function shownWords(page: Page): Promise<string> {
  return (await page.locator(".steer-word:not(.steer-word-ahead)").allTextContents()).join(" ");
}

test("case 1: steer streams words ahead; five steps, a click on a faded word, and Enter keep exactly the shown words", async () => {
  const web = await spawnSteerWeb();
  const api = await openInspectionApi(web);
  const created = await api.createStory("Steer Keep");
  await api.createNode(created.id, { text: "The opening line.", parentId: null });
  const page = await openSteerPage(web, created.id, "Steer Keep");

  expect(await poll(async () => (await knobValue(page, "aria-valuemax")) >= 5)).toBeTrue();
  const grown = await knobValue(page, "aria-valuemax");
  expect(await poll(async () => (await knobValue(page, "aria-valuemax")) > grown)).toBeTrue();

  await knobOf(page).focus();
  for (let step = 0; step < 5; step += 1) await page.keyboard.press("ArrowRight");
  expect(await knobValue(page, "aria-valuenow")).toBe(5);

  // A word ahead of the knob shows faded; a click moves the knob after it.
  expect(await poll(async () => (await knobValue(page, "aria-valuemax")) >= 8)).toBeTrue();
  await page.locator('.steer-word-ahead[data-word="7"]').click();
  expect(await knobValue(page, "aria-valuenow")).toBe(8);
  const shown = await shownWords(page);
  expect(shown.split(" ")).toHaveLength(8);

  await page.keyboard.press("Enter");
  await page.locator(".part").nth(1).waitFor();
  expect(await page.locator(".part").count()).toBe(2);
  expect(await page.locator(".part").nth(1).locator(".prose").textContent()).toBe(shown);
  expect(await poll(async () => (await page.locator(".part").nth(1).getAttribute("aria-current")) === "true")).toBeTrue();

  const saved = await api.loadStory(created.id);
  expect(saved.path).toHaveLength(2);
  expect(saved.path.at(-1)!.text).toBe(shown);
}, 40_000);

test("case 2: going back with Home discards the text ahead and writes it again; Esc saves nothing", async () => {
  const web = await spawnSteerWeb();
  const api = await openInspectionApi(web);
  const created = await api.createStory("Steer Discard");
  await api.createNode(created.id, { text: "The opening line.", parentId: null });
  const before = await api.loadStory(created.id);
  const page = await openSteerPage(web, created.id, "Steer Discard");

  expect(await poll(async () => (await knobValue(page, "aria-valuemax")) >= 10)).toBeTrue();
  await knobOf(page).focus();
  await page.keyboard.press("Shift+ArrowRight");
  await page.waitForTimeout(250);
  expect(await knobValue(page, "aria-valuenow")).toBe(10);

  await page.keyboard.press("Home");
  expect(await knobValue(page, "aria-valuenow")).toBe(0);
  // The text ahead is gone at once, and comes back once the knob has rested.
  await page.waitForFunction(() => document.querySelector('[role="slider"]')?.getAttribute("aria-valuemax") === "0");
  expect(await poll(async () => (await knobValue(page, "aria-valuemax")) > 0)).toBeTrue();

  await page.keyboard.press("Escape");
  await page.getByRole("heading", { name: "Steer Discard" }).waitFor();
  await knobOf(page).waitFor({ state: "detached" });
  expect(await page.locator(".part").count()).toBe(1);

  const after = await api.loadStory(created.id);
  expect(after.path).toHaveLength(before.path.length);
  expect(after.aggregateVersion).toEqual(before.aggregateVersion);
}, 40_000);

test("case 3: a preview saves nothing, finished or aborted", async () => {
  const web = await spawnSteerWeb();
  const api = await openInspectionApi(web);
  const created = await api.createStory("Steer Saves Nothing");
  const first = await api.createNode(created.id, { text: "The opening line.", parentId: null });
  const parentId = first.path.at(-1)!.id;
  const before = await api.loadStory(created.id);
  const preview = api.previewContinuation!.bind(api);

  const deltas: string[] = [];
  const done = await preview(created.id, { parentId, instruction: "", prefix: "" }, (delta) => deltas.push(delta), new AbortController().signal);
  expect(done?.text).toBe(deltas.join(""));
  expect(done?.text).toContain("dry-run text");
  const prefix = "The rain";
  const appended = await preview(created.id, { parentId, instruction: "", prefix }, () => undefined, new AbortController().signal);
  expect((prefix + (appended?.text ?? "")).length).toBeGreaterThan(prefix.length);

  const controller = new AbortController();
  const aborted = await preview(
    created.id,
    { parentId, instruction: "", prefix: "" },
    () => controller.abort(),
    controller.signal
  ).catch(() => null);
  expect(aborted).toBeNull();

  const after = await api.loadStory(created.id);
  expect(after.path).toHaveLength(before.path.length);
  expect(after.aggregateVersion).toEqual(before.aggregateVersion);
}, 40_000);

test("case 4: the steer page stays hidden until Settings › Experimental turns it on", async () => {
  const web = await spawnSteerWeb();
  const api = await openInspectionApi(web);
  const created = await api.createStory("Steer Switch");
  await api.createNode(created.id, { text: "The opening line.", parentId: null });
  const page = await openTestPage(await sharedBrowser());
  await page.goto(web.url);
  await page.getByRole("button", { name: "New story" }).waitFor();
  await page.evaluate((id) => { location.hash = `#/story/${id}`; }, created.id);
  await page.getByRole("heading", { name: "Steer Switch" }).waitFor();
  await page.locator(".part").first().click();

  const palette = page.getByRole("dialog", { name: "Command palette" });
  const steerOption = palette.getByRole("option", { name: /^steer/ });
  await page.keyboard.press(":");
  await palette.waitFor();
  await page.keyboard.type("steer");
  expect(await steerOption.count()).toBe(0);
  await page.keyboard.press("Escape");

  // A direct address shows why the page is closed.
  await page.evaluate((id) => { location.hash = `#/story/${id}/steer`; }, created.id);
  await page.getByText("The steer page is experimental. Turn it on in Settings, under Experimental.").waitFor();
  expect(await knobOf(page).count()).toBe(0);
  await page.keyboard.press("Escape");
  await page.getByRole("heading", { name: "Steer Switch" }).waitFor();

  await page.keyboard.press(",");
  const steerSwitch = page.getByRole("group", { name: "Steer page" });
  await steerSwitch.getByRole("button", { name: "On" }).click();
  expect(await steerSwitch.getByRole("button", { name: "On" }).getAttribute("aria-pressed")).toBe("true");
  await page.keyboard.press("Escape");
  await page.getByRole("heading", { name: "Steer Switch" }).waitFor();
  await page.locator(".part").first().click();

  await page.keyboard.press(":");
  await palette.waitFor();
  await page.keyboard.type("steer");
  await steerOption.waitFor();
  expect(await steerOption.textContent()).toContain("experimental");
  await page.keyboard.press("Enter");
  await knobOf(page).waitFor();
  await page.getByText(/^Experimental\. Scrub a preview/).waitFor();
}, 40_000);
