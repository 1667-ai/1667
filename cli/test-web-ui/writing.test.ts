import { afterEach, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import type { Browser, Locator, Page } from "playwright-core";
import { DRY_RUN_WORD_DELAY_VARIABLE } from "../../server/providers.js";
import { ownedLoopbackHttpSupported } from "../../server/provider-fetch.js";
import { cleanupWebProcesses, scratchProject, spawnWeb, type ReadyWeb } from "../test/web-e2e-fixture.js";
import {
  afterAllHook,
  cleanupWebUiPages,
  launchChrome,
  openInspectionApi,
  openTestPage,
  seedForkedStory,
  type ForkedStory
} from "./web-ui-fixture.js";

/**
 * The remaining writing features (#409 step 10k) in a real browser: rewrite of
 * a selection (with Stop), copy and paste of a story line, a summary take,
 * pruning unused takes, and an attached image. Every case checks the SAVED
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

const servers: Server[] = [];
afterEach(async () => {
  await cleanupWebUiPages();
  await cleanupWebProcesses();
  for (const server of servers.splice(0)) server.close();
});

async function poll(check: () => Promise<boolean>, timeoutMs = 8_000): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    if (await check()) return true;
    if (Date.now() - start > timeoutMs) return await check();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForCount(locator: Locator, count: number, timeoutMs = 8_000): Promise<void> {
  expect(await poll(async () => (await locator.count()) === count, timeoutMs)).toBeTrue();
}

/** Saves `web-10k-<name>.png` into the directory `AI_1667_WEB_UI_SCREENSHOTS`
 * names; does nothing when it is not set. */
async function shot(page: Page, name: string): Promise<void> {
  const directory = process.env.AI_1667_WEB_UI_SCREENSHOTS;
  if (directory === undefined || directory === "") return;
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${directory}/web-10k-${name}.png` });
}

type Api = Awaited<ReturnType<typeof openInspectionApi>>;

interface Opened {
  readonly web: ReadyWeb;
  readonly api: Api;
  readonly seeded: ForkedStory;
  readonly page: Page;
}

async function openForked(
  env: Record<string, string> = {},
  prepare?: (api: Api, seeded: ForkedStory) => Promise<void>
): Promise<Opened> {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], { ...project.env, ...env });
  const api = await openInspectionApi(web);
  const seeded = await seedForkedStory(api);
  if (prepare !== undefined) await prepare(api, seeded);
  const page = await openTestPage(await sharedBrowser(), { viewport: { width: 1400, height: 900 } });
  await page.goto(web.url);
  await page.getByRole("button", { name: "New story" }).waitFor();
  await page.evaluate((id) => { location.hash = `#/story/${id}`; }, seeded.storyId);
  await page.getByRole("heading", { name: "Forked Story" }).waitFor();
  await page.locator(".part").first().waitFor();
  return { web, api, seeded, page };
}

function part(page: Page, text: string): Locator {
  return page.locator(".part").filter({ hasText: text });
}

/** Selects `selected` inside the prose of the part that holds `partText`. */
async function selectInPart(page: Page, partText: string, selected: string): Promise<void> {
  await page.evaluate(([whole, wanted]) => {
    const article = [...document.querySelectorAll(".part")].find((candidate) => candidate.textContent?.includes(whole!));
    const prose = article?.querySelector(".prose");
    if (prose === null || prose === undefined) throw new Error("no prose");
    const walker = document.createTreeWalker(prose, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const at = node.textContent?.indexOf(wanted!) ?? -1;
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + wanted!.length);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    throw new Error(`"${wanted}" not found`);
  }, [partText, selected] as const);
}

async function openMenuOf(page: Page, partText: string): Promise<Locator> {
  await part(page, partText).getByRole("button", { name: "Part actions (x)" }).click();
  const menu = page.getByRole("menu");
  await menu.waitFor();
  return menu;
}

async function savedPath(api: Api, storyId: string) {
  return (await api.loadStory(storyId)).path;
}

const B1_TEXT = "B1: the first take that follows A1.";

test("case 1: Rewrite selection replaces the chosen words in place", async () => {
  const { api, seeded, page } = await openForked();
  await selectInPart(page, "B1:", "first take");
  const menu = await openMenuOf(page, "B1:");
  await menu.getByRole("menuitem", { name: "Rewrite selection" }).click();

  const field = page.getByRole("textbox", { name: "Instruction for the rewrite" });
  await field.waitFor();
  expect(await page.locator(".composer-target").textContent()).toContain("first take");
  await shot(page, "rewrite-composer");
  await field.fill("make it darker");
  await field.press("Enter");

  await page.getByText("Selection rewritten in place.").waitFor();
  expect(await poll(async () => {
    const saved = (await savedPath(api, seeded.storyId))[1];
    return saved !== undefined && !saved.text.includes("first take");
  })).toBeTrue();
  const saved = (await savedPath(api, seeded.storyId))[1]!;
  expect(saved.id).toBe(seeded.b1);
  expect(saved.text.startsWith("B1: the ")).toBeTrue();
  expect(saved.text.endsWith(" that follows A1.")).toBeTrue();
  expect(saved.text).not.toBe(B1_TEXT);
  expect(await part(page, "B1:").locator(".prose").textContent()).toBe(saved.text);
  // The instruction is in the history: ↑ in the empty box brings it back.
  await page.keyboard.press("i");
  await page.getByRole("textbox", { name: "What happens next?" }).press("ArrowUp");
  expect(await page.getByRole("textbox", { name: "What happens next?" }).inputValue()).toBe("make it darker");
}, 90_000);

test("case 2: Esc during a rewrite keeps the streamed text, as the TUI does", async () => {
  const { api, seeded, page } = await openForked({ [DRY_RUN_WORD_DELAY_VARIABLE]: "250" });
  await selectInPart(page, "B1:", "the first take that follows A1");
  const menu = await openMenuOf(page, "B1:");
  await menu.getByRole("menuitem", { name: "Rewrite selection" }).click();
  const field = page.getByRole("textbox", { name: "Instruction for the rewrite" });
  await field.fill("longer please");
  await field.press("Enter");

  await page.getByRole("button", { name: "Stop" }).waitFor();
  // The part already shows the replacement while it streams.
  const prose = part(page, "B1:").locator(".prose");
  expect(await poll(async () => !((await prose.textContent()) ?? "").includes("the first take that follows A1"), 20_000)).toBeTrue();
  await shot(page, "rewrite-streaming");
  await page.keyboard.press("Escape");

  await page.getByText("Rewrite stopped. Streamed text kept.").waitFor();
  await waitForCount(page.getByRole("button", { name: "Stop" }), 0);
  const saved = (await savedPath(api, seeded.storyId))[1]!;
  expect(saved.id).toBe(seeded.b1);
  expect(saved.text).not.toContain("the first take that follows A1");
  expect(saved.text.startsWith("B1: ")).toBeTrue();
  expect(saved.text.endsWith(".")).toBeTrue();
  expect(await prose.textContent()).toBe(saved.text);
}, 90_000);

test("case 3: Copy story line below part 2, Paste story line below part 1: the new line holds the copies", async () => {
  const { api, seeded, page } = await openForked();
  const before = await api.loadStory(seeded.storyId);
  const menu2 = await openMenuOf(page, "B1:");
  // The pasted line is not offered before something is copied.
  expect(await menu2.getByRole("menuitem", { name: "Paste story line below" }).count()).toBe(0);
  await menu2.getByRole("menuitem", { name: "Copy story line below" }).click();
  await page.getByText(/Copied story line/).waitFor();

  const menu1 = await openMenuOf(page, "A1:");
  await shot(page, "line-menu");
  await menu1.getByRole("menuitem", { name: "Paste story line below" }).click();
  await page.getByText(/Pasted story line/).waitFor();

  await waitForCount(page.locator(".part"), 2);
  const path = await savedPath(api, seeded.storyId);
  expect(path.map((node) => node.id)[0]).toBe(seeded.a1);
  expect(path).toHaveLength(2);
  expect(path[1]!.text).toBe("C1: the part that follows B1.");
  expect(path[1]!.id).not.toBe(seeded.c1);
  expect(path[1]!.model).toBe("copied");
  // The copy is a new take of part 2 beside the three that were there.
  const after = await api.loadStory(seeded.storyId);
  expect(after.nodes.length).toBe(before.nodes.length + 1);
  await part(page, "C1:").waitFor();
  // The copy is spent: the paste item is gone again.
  const again = await openMenuOf(page, "A1:");
  expect(await again.getByRole("menuitem", { name: "Paste story line below" }).count()).toBe(0);
}, 90_000);

test("case 4: Prune drafts & discarded shows the counts; confirm removes unused leaves and a tagged line stays", async () => {
  const extra: { discarded: string[] } = { discarded: [] };
  const { api, seeded, page } = await openForked({}, async (client, story) => {
    const ids: string[] = [];
    for (const name of ["C3", "C4", "C5"]) {
      const payload = await client.createNode(story.storyId, { text: `${name}: another way for the story to go.`, parentId: story.b1 });
      ids.push(payload.nodes.find((node) => node.parentId === story.b1 && node.preview.startsWith(`${name}:`))!.id);
    }
    await client.putBookmark(story.storyId, ids[1]!, "Keeper", "");
    await client.switchLine(story.storyId, story.c1);
    extra.discarded = [ids[0]!, ids[2]!];
  });
  const keeper = (await api.loadStory(seeded.storyId)).tags[0]!.nodeId;

  await page.keyboard.press(":");
  await page.keyboard.type("prune");
  await page.getByRole("option", { name: /prune drafts & discarded/ }).waitFor();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Prune unused takes" });
  await dialog.waitFor();
  expect(await dialog.textContent()).toContain("2 unused takes");
  await shot(page, "prune-unused");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect((await api.loadStory(seeded.storyId)).nodes.length).toBe(9);

  await page.keyboard.press(":");
  await page.keyboard.type("prune");
  await page.keyboard.press("Enter");
  await dialog.waitFor();
  await dialog.getByRole("button", { name: /^Delete 2 takes/ }).click();
  await waitForCount(dialog, 0);
  expect(await poll(async () => (await api.loadStory(seeded.storyId)).nodes.length === 7)).toBeTrue();
  const after = await api.loadStory(seeded.storyId);
  expect(after.nodes.some((node) => node.id === keeper)).toBeTrue();
  expect(after.nodes.some((node) => node.id === seeded.c1)).toBeTrue();
  for (const id of extra.discarded) expect(after.nodes.some((node) => node.id === id)).toBeFalse();
  expect(after.tags.map((tag) => tag.name)).toEqual(["Keeper"]);
}, 90_000);

test("case 5: the palette's summary take adds a summary part at the end of the line", async () => {
  const { api, seeded, page } = await openForked();
  await page.keyboard.press(":");
  await page.keyboard.type("summary take");
  await page.getByRole("option", { name: /summary take/ }).waitFor();
  await page.keyboard.press("Enter");

  expect(await poll(async () => (await savedPath(api, seeded.storyId)).at(-1)?.role === "summary", 20_000)).toBeTrue();
  const path = await savedPath(api, seeded.storyId);
  expect(path).toHaveLength(4);
  expect(path.slice(0, 3).map((node) => node.id)).toEqual([seeded.a1, seeded.b1, seeded.c1]);
  await waitForCount(page.locator(".part"), 4);
  await shot(page, "summary-take");
}, 90_000);

/** A model server on this machine that speaks the OpenAI-compatible API and
 * records the body of every chat request. */
interface FakeServer {
  baseUrl: string;
  readonly bodies: string[];
}

async function fakeModelServer(): Promise<FakeServer> {
  const fake: FakeServer = { baseUrl: "", bodies: [] };
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "gpt-4o" }] }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        fake.bodies.push(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(['data: {"choices":[{"delta":{"content":" A door."}}]}', "", "data: [DONE]", "", ""].join("\n"));
      });
      return;
    }
    response.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fake.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return fake;
}

/** A 2×2 PNG, written to disk for the file input. */
async function pngFile(): Promise<string> {
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8Dwn4GBgYGJAQoAHhgCAh6X4CYAAAAASUVORK5CYII=",
    "base64"
  );
  const file = path.join(await mkdtemp(path.join(tmpdir(), "1667-web-image-")), "door.png");
  await writeFile(file, bytes);
  return file;
}

test("case 6: attach image: not offered on a route that cannot take one; on one that can, a chip with a "
  + "thumbnail, Remove, and the image goes with the take", async () => {
  const fake = await fakeModelServer();
  const { api, seeded, page } = await openForked({}, async () => {});
  const file = await pngFile();

  // The dry-run route takes no image: the button says why and stays off.
  const attach = page.getByRole("button", { name: "Attach image" });
  await attach.waitFor();
  expect(await attach.isDisabled()).toBeTrue();
  await page.keyboard.press(":");
  await page.keyboard.type("attach image");
  await page.getByRole("option", { name: /attach image/ }).waitFor();
  await page.keyboard.press("Enter");
  await page.getByText("this protocol does not accept an image").waitFor();

  // Point the page at a model that does.
  await page.keyboard.press("Escape");
  await page.keyboard.press(",");
  await page.getByRole("heading", { name: "Settings", level: 1 }).waitFor();
  await page.getByRole("button", { name: /^Provider/ }).click();
  await page.getByRole("menuitemradio", { name: "OpenAI-compatible", exact: true }).click();
  await page.getByLabel("Base URL", { exact: true }).fill(fake.baseUrl);
  if (!ownedLoopbackHttpSupported()) {
    await page.getByRole("group", { name: "Plain HTTP" }).getByRole("button", { name: "On" }).click();
  }
  await page.getByRole("combobox", { name: "Model" }).click();
  await page.getByRole("option", { name: /^gpt-4o/ }).click();
  await page.keyboard.press("ControlOrMeta+s");
  await page.getByText("Settings saved", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("heading", { name: "Forked Story" }).waitFor();

  await attach.waitFor();
  expect(await poll(async () => !(await attach.isDisabled()))).toBeTrue();
  await page.locator('input[type="file"]').setInputFiles(file);
  const chips = page.getByRole("list", { name: "Attached images" });
  await chips.getByRole("img", { name: "Image 1" }).waitFor();
  expect(await chips.getByRole("listitem").count()).toBe(1);
  await shot(page, "image-chip");
  await chips.getByRole("button", { name: "Remove image 1" }).click();
  await waitForCount(chips.getByRole("listitem"), 0);

  // Attach again and send it with a direction.
  await page.locator('input[type="file"]').setInputFiles(file);
  await chips.getByRole("img", { name: "Image 1" }).waitFor();
  await page.keyboard.press("i");
  const composer = page.getByRole("textbox", { name: "What happens next?" });
  await composer.fill("They find a door.");
  await composer.press("Enter");
  await waitForCount(chips.getByRole("listitem"), 0);
  expect(await poll(async () => fake.bodies.some((body) => body.includes("image_url")), 20_000)).toBeTrue();
  expect(await poll(async () => (await savedPath(api, seeded.storyId)).length === 4, 20_000)).toBeTrue();
  const saved = (await savedPath(api, seeded.storyId)).at(-1)!;
  expect(saved.instruction).toBe("They find a door.");
  const story = await api.loadStory(seeded.storyId);
  expect(story.path.at(-1)!.images?.length ?? 0).toBe(1);
}, 120_000);
