import { afterEach, expect, test } from "bun:test";
import type { Browser, Locator, Page } from "playwright-core";
import { createDurableMutationId } from "../../shared/durable-mutation-id.js";
import { applyBasicSettingsDraft } from "../../shared/settings-basic-draft.js";
import type { StoryApi } from "../../client/api.js";
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
 * The context meter, Facts request status and chapters table in a real browser
 * (#409 step 10f). Locators use roles and accessible names.
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

async function spawnContextWeb(): Promise<ReadyWeb> {
  const project = await scratchProject();
  return await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
}

async function setContextWindow(api: StoryApi, contextWindow: number | null): Promise<void> {
  const view = await api.getSettings();
  if (view.dataFormat !== 2 || !view.editable) throw new Error("expected an editable settings view");
  const mutationId = createDurableMutationId();
  await api.saveSettings({
    transportOperationId: `context-test:${mutationId}`,
    mutationId,
    expectedStateGeneration: view.stateGeneration,
    document: applyBasicSettingsDraft(view.document, { ...view.effective, contextWindow })
  });
}

/** Three plain parts; the second mentions the lighthouse. */
async function seedStory(api: StoryApi, title: string) {
  const created = await api.createStory(title);
  const first = await api.createNode(created.id, { text: "The tide came in over the black rocks.", parentId: null });
  const a = first.path.at(-1)!.id;
  const second = await api.createNode(created.id, { text: "Mara climbed the lighthouse stairs.", parentId: a });
  const b = second.path.at(-1)!.id;
  const third = await api.createNode(created.id, { text: "Far below, the sea went quiet.", parentId: b });
  return { storyId: created.id, a, b, c: third.path.at(-1)!.id };
}

async function openStory(web: ReadyWeb, storyId: string, title: string): Promise<Page> {
  const page = await openTestPage(await sharedBrowser(), { viewport: { width: 1400, height: 900 } });
  await page.goto(web.url);
  await page.getByRole("button", { name: "New story" }).waitFor();
  await page.evaluate((id) => { location.hash = `#/story/${id}`; }, storyId);
  await page.getByRole("heading", { name: title }).waitFor();
  return page;
}

const meter = (page: Page): Locator => page.getByRole("button", { name: /next request/i });
const detail = (page: Page): Locator => page.getByRole("region", { name: "Next request context" });
const factsPanel = (page: Page): Locator => page.getByRole("complementary", { name: "Facts" });
const factRow = (page: Page, name: string): Locator => factsPanel(page).getByRole("listitem").filter({ hasText: name });

/** The number in a figure such as "~1,234" or "1,234". */
function figureOf(text: string): number {
  return Number(text.replace(/[^0-9]/g, ""));
}

async function breakdown(page: Page): Promise<{ readonly total: number; readonly parts: readonly number[] }> {
  const rows = detail(page).getByRole("list", { name: "Context breakdown" }).getByRole("listitem");
  const parts: number[] = [];
  for (let index = 0; index < await rows.count(); index += 1) {
    parts.push(figureOf((await rows.nth(index).locator(".context-legend-count").textContent()) ?? ""));
  }
  const total = figureOf((await detail(page).locator(".context-total-value").textContent()) ?? "");
  return { total, parts };
}

test("case 1: with a context window set the meter shows tokens and window, and typing a direction raises the count after a pause", async () => {
  const web = await spawnContextWeb();
  const api = await openInspectionApi(web);
  await setContextWindow(api, 8_000);
  const seeded = await seedStory(api, "Meter Story");
  const page = await openStory(web, seeded.storyId, "Meter Story");
  const diagnostics = await collectPageDiagnostics(page);

  await meter(page).waitFor();
  expect(await poll(async () => /~\d[\d.]*k? \/ 8k/.test((await meter(page).textContent()) ?? ""))).toBeTrue();
  await meter(page).click();
  await detail(page).waitFor();
  const before = (await breakdown(page)).total;
  expect(before).toBeGreaterThan(0);
  await screenshot(page, "10f-meter-expanded");

  await page.getByRole("textbox", { name: "What happens next?" }).fill("Mara finds a hidden door behind the lamp and hears someone knocking from the other side. ".repeat(12));
  expect(await poll(async () => (await breakdown(page)).total > before)).toBeTrue();
  expect(diagnostics.consoleErrors).toEqual([]);
  expect(diagnostics.cspViolations).toEqual([]);
}, 60_000);

test("case 2: a keyed Fact whose key is in recent prose shows sent; another shows not matched", async () => {
  const web = await spawnContextWeb();
  const api = await openInspectionApi(web);
  await setContextWindow(api, 8_000);
  const seeded = await seedStory(api, "Fact Status");
  await api.createFact(seeded.storyId, { name: "Beacon", activation: "keyed", keys: ["lighthouse"], text: "The lighthouse has a green lamp." });
  await api.createFact(seeded.storyId, { name: "Dragon", activation: "keyed", keys: ["dragon"], text: "A dragon sleeps under the sea." });
  const page = await openStory(web, seeded.storyId, "Fact Status");

  await page.keyboard.press("f");
  await factsPanel(page).waitFor();
  await factRow(page, "Beacon").getByText("sent", { exact: true }).waitFor();
  await factRow(page, "Dragon").getByText("not matched", { exact: true }).waitFor();
  await screenshot(page, "10f-fact-status");
}, 60_000);

test("case 3: a Facts budget below one Fact shows dropped and the meter's drop notice", async () => {
  const web = await spawnContextWeb();
  const api = await openInspectionApi(web);
  await setContextWindow(api, 8_000);
  const seeded = await seedStory(api, "Budget Story");
  await api.createFact(seeded.storyId, {
    name: "Chronicle",
    activation: "keyed",
    keys: ["tide"],
    text: "The long chronicle of the lighthouse keepers of the northern reef lists every keeper, every storm and every ship lost at the black rocks."
  });
  await api.setFactsBudget(seeded.storyId, 5);
  const page = await openStory(web, seeded.storyId, "Budget Story");

  await page.keyboard.press("f");
  await factsPanel(page).waitFor();
  await factRow(page, "Chronicle").getByText(/dropped · over/).waitFor();
  await meter(page).click();
  await detail(page).getByText(/1 fact dropped · over/).waitFor();
  await screenshot(page, "10f-fact-dropped");
}, 60_000);

test("case 4: the expanded categories add up to the total", async () => {
  const web = await spawnContextWeb();
  const api = await openInspectionApi(web);
  await setContextWindow(api, 8_000);
  const seeded = await seedStory(api, "Sum Story");
  await api.createFact(seeded.storyId, { name: "Beacon", text: "The lighthouse has a green lamp." });
  const page = await openStory(web, seeded.storyId, "Sum Story");

  await meter(page).waitFor();
  await meter(page).click();
  await detail(page).waitFor();
  const { total, parts } = await breakdown(page);
  expect(parts.length).toBeGreaterThanOrEqual(3);
  expect(parts.reduce((sum, value) => sum + value, 0)).toBe(total);
  // Esc closes the breakdown and the button says so.
  await page.keyboard.press("Escape");
  await detail(page).waitFor({ state: "detached" });
  expect(await meter(page).getAttribute("aria-expanded")).toBe("false");
}, 60_000);

test("case 5: with no context window the meter asks for one and opens Settings", async () => {
  const web = await spawnContextWeb();
  const api = await openInspectionApi(web);
  await setContextWindow(api, null);
  const seeded = await seedStory(api, "No Window");
  const page = await openStory(web, seeded.storyId, "No Window");

  await meter(page).waitFor();
  expect(await meter(page).textContent()).toContain("tokens");
  await meter(page).click();
  await detail(page).getByRole("button", { name: /set context window/ }).click();
  await page.getByRole("heading", { name: "Settings", level: 1 }).waitFor();
}, 60_000);

test("case 6: the chapters table says what the next request does with each chapter", async () => {
  const web = await spawnContextWeb();
  const api = await openInspectionApi(web);
  await setContextWindow(api, 8_000);
  const created = await api.createStory("Chapter Context");
  const long = "The keepers wrote down every storm in the ledger and every ship that the black rocks took. ".repeat(24);
  const first = await api.createNode(created.id, { text: long, parentId: null });
  const second = await api.createNode(created.id, { text: "Mara climbed the lighthouse stairs.", parentId: first.path.at(-1)!.id });
  await api.createNode(created.id, { text: "Far below, the sea went quiet.", parentId: second.path.at(-1)!.id });
  const seeded = { storyId: created.id, b: second.path.at(-1)!.id };
  await api.createChapterBreak(seeded.storyId, seeded.b, "Second");
  const page = await openStory(web, seeded.storyId, "Chapter Context");

  await page.keyboard.press("c");
  const chapters = page.getByRole("list", { name: "Chapters" });
  await chapters.waitFor();
  await chapters.getByRole("listitem").first().getByText(/Sent in full · ~\d/).waitFor();
  expect(await chapters.getByRole("listitem").first().textContent()).toContain("a summary frees");
  await chapters.getByRole("listitem").nth(1).getByText(/Sent in full/).waitFor();
  await screenshot(page, "10f-chapters-context");
}, 60_000);
