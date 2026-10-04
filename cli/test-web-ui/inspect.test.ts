import { afterEach, expect, test } from "bun:test";
import type { Browser, Locator, Page } from "playwright-core";
import { createDurableMutationId } from "../../shared/durable-mutation-id.js";
import type { StoryApi } from "../../client/api.js";
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
 * The inspector pages in a real browser (#409 step 10g): the next request,
 * generation records, token probabilities and a take's stored thought. They
 * run on the dry-run provider, which makes up reasoning and probabilities.
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

async function poll(check: () => Promise<boolean>, timeoutMs = 8_000): Promise<boolean> {
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

async function spawnInspectWeb(): Promise<ReadyWeb> {
  const project = await scratchProject();
  return await spawnWeb(
    ["--data", project.dataDir, "--port", "0", "--no-open"],
    { ...project.env, [DRY_RUN_WORD_DELAY_VARIABLE]: "2" }
  );
}

/** Asks the dry-run route for `count` alternatives per token. */
async function setAlternatives(api: StoryApi, count: number): Promise<void> {
  const view = await api.getSettings();
  if (view.dataFormat !== 2 || !view.editable) throw new Error("expected an editable settings view");
  const document = view.document;
  const id = document.routing.default;
  const mutationId = createDurableMutationId();
  await api.saveSettings({
    transportOperationId: `inspect-test:${mutationId}`,
    mutationId,
    expectedStateGeneration: view.stateGeneration,
    document: { ...document, profiles: { ...document.profiles, [id]: { ...document.profiles[id]!, tokenProbabilities: count } } }
  });
}

async function seedStory(api: StoryApi, title: string): Promise<string> {
  const created = await api.createStory(title);
  const first = await api.createNode(created.id, { text: "The tide came in over the black rocks.", parentId: null });
  await api.createNode(created.id, { text: "Mara climbed the lighthouse stairs.", parentId: first.path.at(-1)!.id });
  return created.id;
}

async function openStory(web: ReadyWeb, storyId: string, title: string): Promise<Page> {
  const page = await openTestPage(await sharedBrowser(), { viewport: { width: 1400, height: 900 } });
  await page.goto(web.url);
  await page.getByRole("button", { name: "New story" }).waitFor();
  await page.evaluate((id) => { location.hash = `#/story/${id}`; }, storyId);
  await page.getByRole("heading", { name: title, level: 1 }).waitFor();
  return page;
}

const part = (page: Page, text: string): Locator => page.locator(".part").filter({ hasText: text });
const hash = (page: Page): Promise<string> => page.evaluate(() => location.hash);
const focusedPartText = (page: Page): Promise<string | null> =>
  page.evaluate(() => document.activeElement?.closest(".part")?.textContent ?? null);

/** Writes one more part with the Continue button and waits for it to land. */
async function continueOnce(page: Page, parts: number): Promise<void> {
  // A typed direction opens a new take, so the part count grows.
  await page.getByRole("textbox", { name: "What happens next?" }).fill("Go on.");
  await page.getByRole("button", { name: "Continue" }).click();
  expect(await poll(async () => (await page.locator(".part").count()) === parts && (await page.getByRole("button", { name: "Continue" }).count()) === 1, 20_000)).toBeTrue();
}

test("case 1: the palette opens the next request with the Author's Note at its depth; Esc and Back return to the story with focus kept", async () => {
  const web = await spawnInspectWeb();
  const api = await openInspectionApi(web);
  const storyId = await seedStory(api, "Request Story");
  await api.setAuthorsNote(storyId, "Keep the tide in view.", 2);
  const page = await openStory(web, storyId, "Request Story");
  const diagnostics = await collectPageDiagnostics(page);
  await part(page, "black rocks").click();
  expect(await poll(async () => (await focusedPartText(page))?.includes("black rocks") === true)).toBeTrue();

  await page.keyboard.press(":");
  await page.getByRole("dialog", { name: "Command palette" }).waitFor();
  await page.keyboard.type("next request");
  await page.keyboard.press("Enter");
  await page.getByRole("heading", { name: "Next request", level: 1 }).waitFor();
  expect(await hash(page)).toBe(`#/story/${storyId}/request`);
  const messages = page.getByRole("list", { name: "Next request messages" }).getByRole("listitem");
  expect(await messages.count()).toBeGreaterThanOrEqual(4);
  const note = messages.filter({ hasText: "authors note" });
  expect(await note.count()).toBe(1);
  expect(await note.textContent()).toContain("depth 1");
  expect(await note.textContent()).toContain("Keep the tide in view.");
  await screenshot(page, "10g-request");

  await page.keyboard.press("Escape");
  await page.getByRole("heading", { name: "Request Story", level: 1 }).waitFor();
  expect(await poll(async () => (await focusedPartText(page))?.includes("black rocks") === true)).toBeTrue();

  // The meter's button opens it too; Back returns.
  await page.getByRole("button", { name: /next request/i }).click();
  await page.getByRole("button", { name: "View next request" }).click();
  await page.getByRole("heading", { name: "Next request", level: 1 }).waitFor();
  await page.goBack();
  await page.getByRole("heading", { name: "Request Story", level: 1 }).waitFor();
  expect(await poll(async () => (await focusedPartText(page))?.includes("black rocks") === true)).toBeTrue();
  expect(diagnostics.consoleErrors).toEqual([]);
  expect(diagnostics.cspViolations).toEqual([]);
}, 90_000);

test("case 2: after a Continue, h lists one record and opening it shows the prompt entries and the output", async () => {
  const web = await spawnInspectWeb();
  const api = await openInspectionApi(web);
  const storyId = await seedStory(api, "Record Story");
  const page = await openStory(web, storyId, "Record Story");
  await part(page, "lighthouse stairs").click();
  await continueOnce(page, 3);
  expect(await poll(async () => (await focusedPartText(page))?.includes("dry-run") === true)).toBeTrue();

  await page.keyboard.press("h");
  await page.getByRole("heading", { name: "Generation records", level: 1 }).waitFor();
  expect(await hash(page)).toContain(`#/story/${storyId}/records/`);
  expect(await page.getByRole("list", { name: "Events" }).getByRole("listitem").count()).toBe(1);
  const entries = page.getByRole("list", { name: "Prompt entries" }).getByRole("listitem");
  await entries.first().waitFor();
  expect(await entries.count()).toBeGreaterThanOrEqual(3);
  expect(await entries.filter({ hasText: "output" }).textContent()).toContain("dry-run");
  await screenshot(page, "10g-records");
  await page.keyboard.press("Escape");
  await page.getByRole("heading", { name: "Record Story", level: 1 }).waitFor();
}, 90_000);

test("case 3: with 5 alternatives, l shows the token; the arrows move tokens and alternatives; Tab goes to the next part", async () => {
  const web = await spawnInspectWeb();
  const api = await openInspectionApi(web);
  await setAlternatives(api, 5);
  const storyId = await seedStory(api, "Probability Story");
  const page = await openStory(web, storyId, "Probability Story");
  await part(page, "lighthouse stairs").click();
  await continueOnce(page, 3);
  await continueOnce(page, 4);
  await part(page, "dry-run").first().click();
  expect(await poll(async () => (await focusedPartText(page))?.includes("dry-run") === true)).toBeTrue();

  await page.keyboard.press("l");
  await page.getByRole("heading", { name: "Token probabilities", level: 1 }).waitFor();
  const first = (await hash(page));
  const alternatives = page.getByRole("region", { name: /Alternatives for token 1 of/ });
  await alternatives.waitFor();
  expect(await alternatives.getByRole("listitem").first().textContent()).toMatch(/\d+(\.\d+)?%/);
  await screenshot(page, "10g-probs");

  await page.keyboard.press("ArrowRight");
  await page.getByRole("region", { name: /Alternatives for token 2 of/ }).waitFor();
  await page.keyboard.press("ArrowDown");
  const rows = page.getByRole("region", { name: /Alternatives for token 2 of/ }).getByRole("listitem");
  expect(await rows.nth(1).getAttribute("aria-current")).toBe("true");

  await page.keyboard.press("Tab");
  expect(await poll(async () => (await hash(page)) !== first)).toBeTrue();
  await page.getByRole("region", { name: /Alternatives for token 1 of/ }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("heading", { name: "Probability Story", level: 1 }).waitFor();
}, 120_000);

test("case 4: l and h on a part you wrote say there is nothing to show", async () => {
  const web = await spawnInspectWeb();
  const api = await openInspectionApi(web);
  const storyId = await seedStory(api, "Human Story");
  const page = await openStory(web, storyId, "Human Story");
  await part(page, "black rocks").click();

  await page.keyboard.press("l");
  await page.getByRole("heading", { name: "Token probabilities", level: 1 }).waitFor();
  await page.getByText(/Set alt count/).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("heading", { name: "Human Story", level: 1 }).waitFor();

  await page.keyboard.press("h");
  await page.getByRole("heading", { name: "Generation records", level: 1 }).waitFor();
  await page.getByText("This take has no generation records.").waitFor();
}, 60_000);

test("case 5: h on a map row opens the records of that take, and Back returns to the map", async () => {
  const web = await spawnInspectWeb();
  const api = await openInspectionApi(web);
  const storyId = await seedStory(api, "Map Records");
  const page = await openStory(web, storyId, "Map Records");
  await part(page, "lighthouse stairs").click();
  await continueOnce(page, 3);

  await page.keyboard.press("m");
  await page.getByRole("heading", { name: "Map", level: 1 }).waitFor();
  await page.keyboard.press("h");
  await page.getByRole("heading", { name: "Generation records", level: 1 }).waitFor();
  expect(await page.getByRole("list", { name: "Events" }).getByRole("listitem").count()).toBe(1);
  await page.goBack();
  await page.getByRole("heading", { name: "Map", level: 1 }).waitFor();
  expect(await hash(page)).toBe(`#/story/${storyId}/map`);
}, 90_000);

test("case 6: T shows and hides the stored thought of a landed take; none shows while text streams", async () => {
  const web = await spawnInspectWeb();
  const api = await openInspectionApi(web);
  const storyId = await seedStory(api, "Mind Story");
  const page = await openStory(web, storyId, "Mind Story");
  await part(page, "lighthouse stairs").click();
  await page.getByRole("textbox", { name: "What happens next?" }).fill("Go on.");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.locator(".part-streaming").waitFor();
  expect(await page.getByRole("button", { name: "Thought", exact: true }).count()).toBe(0);
  expect(await page.getByRole("region", { name: "Thought" }).count()).toBe(0);
  expect(await poll(async () => (await page.locator(".part").count()) === 3 && (await page.getByRole("button", { name: "Continue" }).count()) === 1, 20_000)).toBeTrue();

  const toggle = page.getByRole("button", { name: /^Thought/ });
  await toggle.waitFor();
  expect(await toggle.getAttribute("aria-expanded")).toBe("false");
  expect(await page.getByRole("region", { name: "Thought" }).count()).toBe(0);
  await page.keyboard.press("Shift+T");
  await page.getByRole("region", { name: "Thought" }).waitFor();
  expect((await page.getByRole("region", { name: "Thought" }).textContent())?.length).toBeGreaterThan(10);
  await screenshot(page, "10g-thought");
  await page.keyboard.press("Shift+T");
  await page.getByRole("region", { name: "Thought" }).waitFor({ state: "detached" });
}, 90_000);
