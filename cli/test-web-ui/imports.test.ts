import { afterEach, expect, test } from "bun:test";
import type { Browser, Locator, Page } from "playwright-core";
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
 * File imports in a real browser (#409 step 10i): the Library's Import button
 * and file drop make new stories; the palette's "import character card" and
 * "import archive" add Facts to the open story. Every case checks the SAVED
 * story through a second connection.
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

async function spawnImportWeb(): Promise<ReadyWeb> {
  const project = await scratchProject();
  return await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
}

type Api = Awaited<ReturnType<typeof openInspectionApi>>;

async function openLibrary(web: ReadyWeb): Promise<Page> {
  const page = await openTestPage(await sharedBrowser(), { viewport: { width: 1400, height: 900 } });
  await page.goto(web.url);
  await page.getByRole("button", { name: "New story" }).waitFor();
  return page;
}

/** A story `A → B` of plain parts, opened on its page. */
async function openSeededStory(web: ReadyWeb, api: Api): Promise<{ page: Page; storyId: string }> {
  const created = await api.createStory("Host Story");
  const first = await api.createNode(created.id, { text: "A: the opening part.", parentId: null });
  await api.createNode(created.id, { text: "B: the last part.", parentId: first.path.at(-1)!.id });
  const page = await openLibrary(web);
  await page.evaluate((id) => { location.hash = `#/story/${id}`; }, created.id);
  await page.getByRole("heading", { name: "Host Story" }).waitFor();
  return { page, storyId: created.id };
}

const palette = (page: Page): Locator => page.getByRole("dialog", { name: "Command palette" });
const result = (page: Page): Locator => page.getByRole("dialog", { name: "Import result" });

/** Runs a palette command that opens a file chooser, and answers it with one file. */
async function paletteImport(page: Page, query: string, file: { name: string; mimeType: string; buffer: Buffer }): Promise<void> {
  await page.locator(".part").first().click();
  await page.keyboard.press(":");
  await palette(page).waitFor();
  await page.keyboard.type(query);
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.keyboard.press("Enter")]);
  await chooser.setFiles(file);
}

async function findStory(api: Api, title: string): Promise<{ id: string } | undefined> {
  return (await api.listStories()).find((story) => story.title === title);
}

const MARKDOWN = `# Imported Tale

The lamp was lit at dusk.

## Chapter 2: The Dark Forest

The path ran into the trees.

## Chapter 3: The Summit

Only the wind was left.
`;

test("case 1: a Markdown file with two ## headings makes a story with their chapters and opens it", async () => {
  const web = await spawnImportWeb();
  const api = await openInspectionApi(web);
  const page = await openLibrary(web);
  const diagnostics = await collectPageDiagnostics(page);

  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByRole("button", { name: "Import story" }).click()
  ]);
  await chooser.setFiles({ name: "tale.md", mimeType: "text/markdown", buffer: Buffer.from(MARKDOWN) });
  await page.getByRole("heading", { name: "Imported Tale" }).waitFor();
  expect(page.url()).toContain("#/story/");

  const story = await findStory(api, "Imported Tale");
  expect(story).toBeDefined();
  const saved = await api.loadStory(story!.id);
  expect(saved.path).toHaveLength(3);
  expect(saved.chapterBreaks.map((chapterBreak) => chapterBreak.title)).toEqual(["Chapter 2: The Dark Forest", "Chapter 3: The Summit"]);

  await page.keyboard.press("c");
  const chapters = page.getByRole("list", { name: "Chapters" });
  await chapters.getByText("Chapter 2: The Dark Forest").waitFor();
  expect(await chapters.getByRole("listitem").count()).toBe(3);
  await screenshot(page, "10i-markdown");
  expect(diagnostics.consoleErrors).toEqual([]);
  expect(diagnostics.cspViolations).toEqual([]);
}, 90_000);

test("case 2: a SillyTavern .jsonl file dropped on the page makes parts that carry their directions", async () => {
  const web = await spawnImportWeb();
  const api = await openInspectionApi(web);
  const page = await openLibrary(web);
  const jsonl = [
    JSON.stringify({ character_name: "Ashe", user_name: "You" }),
    JSON.stringify({ is_user: true, mes: "Which way do we go?" }),
    JSON.stringify({ is_user: false, mes: "Ashe points down the low path." }),
    JSON.stringify({ is_user: true, mes: "Lead on." }),
    JSON.stringify({ is_user: false, mes: "She sets off without a word." })
  ].join("\n");

  const drag = (type: "dragenter" | "drop"): Promise<void> => page.evaluate(({ kind, text }) => {
    const data = new DataTransfer();
    data.items.add(new File([text], "Ashe chat.jsonl", { type: "application/jsonl" }));
    document.body.dispatchEvent(new DragEvent(kind, { dataTransfer: data, bubbles: true, cancelable: true }));
  }, { kind: type, text: jsonl });
  await drag("dragenter");
  await page.getByText("Drop a story file to import it").waitFor();
  await screenshot(page, "10i-drop");
  await drag("drop");
  await page.getByText("Ashe points down the low path.").first().waitFor();
  expect(await page.getByText("Drop a story file to import it").count()).toBe(0);

  const listed = (await api.listStories()).find((story) => story.title !== "Start Here" && story.title !== "A Door in the Hedge");
  expect(listed).toBeDefined();
  const saved = await api.loadStory(listed!.id);
  expect(saved.path.map((node) => node.text)).toEqual(["Ashe points down the low path.", "She sets off without a word."]);
  expect(saved.path.map((node) => node.instruction)).toEqual(["Which way do we go?", "Lead on."]);
}, 90_000);

test("case 3: a character card imported into the open story adds Facts; the result dialog and the Facts panel list them", async () => {
  const web = await spawnImportWeb();
  const api = await openInspectionApi(web);
  const { page, storyId } = await openSeededStory(web, api);
  const card = { spec: "chara_card_v2", spec_version: "2.0", data: { name: "Mara", description: "A lighthouse keeper.", personality: "Stern but fair.", scenario: "" } };

  await paletteImport(page, "import character card", { name: "mara.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(card)) });
  await result(page).waitFor();
  await result(page).getByText(/1 Fact for "Mara"/).waitFor();
  expect(await result(page).getByRole("region", { name: "Facts added" }).getByRole("listitem").count()).toBe(1);
  expect(await result(page).getByText("Nothing was left out.").count()).toBe(1);
  await screenshot(page, "10i-card-result");

  const facts = (await api.loadStory(storyId)).facts;
  expect(facts).toHaveLength(1);
  expect(facts[0]!.tag).toBe("Character");
  await result(page).getByRole("button", { name: "Close" }).click();
  await result(page).waitFor({ state: "detached" });

  await page.keyboard.press("f");
  const rows = page.getByRole("complementary", { name: "Facts" }).getByRole("list", { name: "Facts" }).getByRole("listitem");
  await rows.first().waitFor();
  expect(await rows.count()).toBe(1);
  expect(await rows.first().textContent()).toContain("Name: Mara");
}, 90_000);

test("case 4: a .lorebook file adds keyed Facts and the dialog shows what was left out", async () => {
  const web = await spawnImportWeb();
  const api = await openInspectionApi(web);
  const { page, storyId } = await openSeededStory(web, api);
  const book = {
    lorebookVersion: 6,
    categories: [],
    entries: [
      { enabled: true, text: "The reef is black and sharp.", displayName: "The Reef", keys: ["reef", "rocks"], forceActivation: false },
      { enabled: true, text: "Mara keeps the light.", displayName: "Mara", keys: [], forceActivation: true },
      { enabled: false, text: "Disabled entry.", displayName: "Gone" }
    ]
  };

  await paletteImport(page, "import archive", { name: "coast.lorebook", mimeType: "application/octet-stream", buffer: Buffer.from(JSON.stringify(book)) });
  await result(page).waitFor();
  await result(page).getByText("2 Facts imported · 1 keyed · 1 always").waitFor();
  expect(await result(page).getByRole("region", { name: "Facts added" }).getByRole("listitem").allTextContents()).toEqual(["The Reef", "Mara"]);
  await result(page).getByText("1 disabled entry skipped").waitFor();
  await screenshot(page, "10i-lorebook-result");

  const facts = (await api.loadStory(storyId)).facts;
  expect(facts).toHaveLength(2);
  expect(facts.find((fact) => fact.tag === "The Reef")).toMatchObject({ activation: "keyed", keys: ["reef", "rocks"] });
  expect(facts.find((fact) => fact.tag === "Mara")).toMatchObject({ activation: "always" });
}, 90_000);

test("case 5: an unsupported file shows the error text and changes nothing; a file over the limit is refused unsent", async () => {
  const web = await spawnImportWeb();
  const api = await openInspectionApi(web);
  const { page, storyId } = await openSeededStory(web, api);
  const storiesBefore = (await api.listStories()).length;

  await paletteImport(page, "import archive", { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await page.getByText("unsupported archive · use .lorebook, .json, .png, .scenario, or .story").first().waitFor();
  expect(await result(page).count()).toBe(0);

  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByRole("button", { name: "Import story" }).click()
  ]);
  await chooser.setFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await page.getByText("unsupported file · use .md, .jsonl, .story, or .scenario").first().waitFor();

  await paletteImport(page, "import character card", { name: "huge.png", mimeType: "image/png", buffer: Buffer.alloc(20_000_001) });
  await page.getByText("file is 20MB — larger than the 20MB import limit").first().waitFor();
  await screenshot(page, "10i-refused");

  expect((await api.listStories()).length).toBe(storiesBefore);
  expect((await api.loadStory(storyId)).facts).toHaveLength(0);
}, 90_000);
