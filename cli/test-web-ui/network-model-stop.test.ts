import { afterEach, expect, test } from "bun:test";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import type { Browser, Locator, Page } from "playwright-core";
import { createDurableMutationId } from "../../shared/durable-mutation-id.js";
import { applyBasicSettingsDraft } from "../../shared/settings-basic-draft.js";
import type { StoryApi } from "../../client/api.js";
import { cleanupWebProcesses, scratchProject, spawnWeb } from "../test/web-e2e-fixture.js";
import {
  afterAllHook,
  cleanupWebUiPages,
  launchChrome,
  openInspectionApi,
  openTestPage,
  seedForkedStory
} from "./web-ui-fixture.js";

/**
 * Stop against a model server on this machine, in a real browser (issue
 * #458). The dry-run provider in `generation.test.ts` has no HTTP stream, so
 * it cannot show how a stopped stream ends. Here the model is an
 * OpenAI-compatible server on the loopback address whose stream ends at
 * connection close, as KoboldCpp's does. With Bun 1.4, an abort of such a
 * response looks like a normal end of the body. Every case checks the SAVED
 * story, not only what is on screen.
 */

let browser: Browser | null = null;
const servers: Server[] = [];

afterAllHook(async () => {
  await browser?.close();
});

afterEach(async () => {
  await cleanupWebUiPages();
  await cleanupWebProcesses();
  for (const server of servers.splice(0)) server.close();
});

/** An OpenAI-compatible chat server that answers the way KoboldCpp does:
 * HTTP/1.0, with no Content-Length and no chunked encoding, so the stream
 * ends when the connection closes. It streams one word every 40 ms for about
 * three seconds. A Stop after the first words always lands before the end. */
async function slowModelServer(): Promise<string> {
  const server = createServer((socket) => {
    socket.on("error", () => {});
    let received = "";
    let answered = false;
    socket.on("data", (chunk: Buffer) => {
      received += chunk.toString("latin1");
      const headerEnd = received.indexOf("\r\n\r\n");
      if (answered || headerEnd < 0) return;
      const length = Number(/content-length:\s*(\d+)/i.exec(received.slice(0, headerEnd))?.[1] ?? 0);
      if (received.length - (headerEnd + 4) < length) return;
      answered = true;
      const [method, target] = received.split(" ");
      if (method === "POST" && target === "/v1/chat/completions") streamWords(socket);
      else socket.end("HTTP/1.0 404 Not Found\r\nContent-Length: 0\r\n\r\n");
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

function streamWords(socket: Socket): void {
  socket.write("HTTP/1.0 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-cache\r\n\r\n");
  let word = 0;
  const timer = setInterval(() => {
    if (socket.destroyed) {
      clearInterval(timer);
      return;
    }
    if (word === 80) {
      clearInterval(timer);
      socket.end("data: [DONE]\n\n");
      return;
    }
    const delta = { choices: [{ delta: { content: ` word${word}` } }] };
    socket.write(`data: ${JSON.stringify(delta)}\n\n`);
    word += 1;
  }, 40);
  socket.on("close", () => clearInterval(timer));
}

async function useModelServer(api: StoryApi, baseUrl: string): Promise<void> {
  const view = await api.getSettings();
  if (view.dataFormat !== 2 || !view.editable) {
    throw new Error(`expected an editable, current-format settings view, got dataFormat ${view.dataFormat}`);
  }
  const mutationId = createDurableMutationId();
  await api.saveSettings({
    transportOperationId: `network-model-stop:${mutationId}`,
    mutationId,
    expectedStateGeneration: view.stateGeneration,
    document: applyBasicSettingsDraft(view.document, {
      ...view.effective,
      provider: "openai-compatible",
      baseUrl,
      model: "slow-model",
      apiKeyEnv: null,
      allowInsecureHttp: true
    })
  });
}

async function poll(check: () => Promise<boolean>, timeoutMs = 8_000): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    if (await check()) return true;
    if (Date.now() - start > timeoutMs) return await check();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function part(page: Page, text: string): Locator {
  return page.locator(".part").filter({ hasText: text });
}

async function streamingProse(page: Page): Promise<string> {
  return (await page.locator(".part-streaming .prose").textContent()) ?? "";
}

test("case 1: Esc during a Retake keeps the partial take - it is saved as a new take, "
  + "the line shows it, and it survives a reload", async () => {
  const baseUrl = await slowModelServer();
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const api = await openInspectionApi(web);
  await useModelServer(api, baseUrl);
  const seeded = await seedForkedStory(api);

  browser ??= await launchChrome();
  const page = await openTestPage(browser);
  await page.goto(web.url);
  await page.getByRole("button", { name: "New story" }).waitFor();
  await page.evaluate((id) => { location.hash = `#/story/${id}`; }, seeded.storyId);
  await page.getByRole("heading", { name: "Forked Story" }).waitFor();

  await part(page, "B1:").click();
  await page.keyboard.press("r");
  expect(await poll(async () => (await streamingProse(page)).includes("word3"))).toBeTrue();
  await page.keyboard.press("Escape");
  expect(await poll(async () => (await page.getByRole("button", { name: "Continue" }).count()) === 1)).toBeTrue();

  const story = await api.loadStory(seeded.storyId);
  const takes = story.nodes.filter((node) => node.parentId === seeded.a1);
  expect(takes).toHaveLength(4);
  const partial = story.path[1]!;
  expect([seeded.b1, seeded.b2, seeded.b3]).not.toContain(partial.id);
  expect(partial.text.startsWith("word0 word1 word2 word3")).toBeTrue();
  expect(partial.text).not.toContain("word79");

  const onScreen = page.locator(".part").nth(1).locator(".prose");
  expect(await poll(async () => (await onScreen.textContent()) === partial.text)).toBeTrue();
  await page.reload();
  await page.getByRole("heading", { name: "Forked Story" }).waitFor();
  expect(await poll(async () => (await onScreen.textContent()) === partial.text)).toBeTrue();
}, 60_000);
