import { afterEach, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Browser, Page } from "playwright-core";
import type { StoryApi } from "../../client/api.js";
import { ownedLoopbackHttpSupported } from "../../server/provider-fetch.js";
import { cleanupWebProcesses, scratchProject, spawnWeb } from "../test/web-e2e-fixture.js";
import {
  afterAllHook,
  cleanupWebUiPages,
  launchChrome,
  openInspectionApi,
  openTestPage
} from "./web-ui-fixture.js";

/**
 * A local model server can listen on any port. The provider that the writer
 * picks must stay selected when the writer types the real address, or the
 * settings that the server accepts (banned strings here) refuse to save.
 */

let browser: Browser | null = null;
const servers: Server[] = [];
afterAllHook(async () => { await browser?.close(); });
afterEach(async () => {
  await cleanupWebUiPages();
  await cleanupWebProcesses();
  for (const server of servers.splice(0)) server.close();
});

const SERVED_MODEL = "gemma-4-31b-it-uncensored-heretic-q8";

/** A llama-server on a port that is not 8080. Its `/v1/models` reply has the
 * shape that llama.cpp b12651 sends for one loaded model. */
async function llamaServer(): Promise<{ baseUrl: string; tokenized: string[] }> {
  const tokenized: string[] = [];
  const server = createServer((request, response) => {
    const send = (body: unknown): void => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.method === "GET" && request.url === "/v1/models") {
      send({
        object: "list",
        data: [{
          id: SERVED_MODEL,
          aliases: [SERVED_MODEL],
          object: "model",
          owned_by: "llamacpp",
          meta: { n_ctx: 32_768, n_ctx_train: 262_144, n_vocab: 262_144 }
        }]
      });
      return;
    }
    if (request.method === "GET" && request.url === "/props") {
      send({ default_generation_settings: { n_ctx: 32_768 } });
      return;
    }
    if (request.method === "POST" && request.url === "/tokenize") {
      let raw = "";
      request.on("data", (chunk: Buffer) => { raw += chunk.toString("utf8"); });
      request.on("end", () => {
        tokenized.push(String((JSON.parse(raw) as { content?: unknown }).content));
        send({ tokens: [4242] });
      });
      return;
    }
    response.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, tokenized };
}

async function chooseProvider(page: Page, label: string, baseUrl: string): Promise<void> {
  await page.getByRole("button", { name: /^Provider/ }).click();
  await page.getByRole("menuitemradio", { name: label, exact: true }).click();
  await page.getByLabel("Base URL", { exact: true }).fill(baseUrl);
  if (!ownedLoopbackHttpSupported()) {
    await page.getByRole("group", { name: "Plain HTTP" }).getByRole("button", { name: "On" }).click();
  }
  await page.getByText(/1 model listed/).waitFor();
}

async function save(page: Page): Promise<void> {
  await page.keyboard.press("ControlOrMeta+s");
  await page.getByText("Settings saved", { exact: true }).waitFor();
  await page.getByRole("region", { name: "Settings changes" }).waitFor({ state: "detached" });
}

async function savedRoute(api: StoryApi) {
  const document = (await api.getSettings()).document!;
  const profile = document.profiles[document.routing.default]!;
  const model = document.models[profile.modelId]!;
  return { profile, model, connection: document.connections[model.connectionId]! };
}

async function screenshot(page: Page, name: string): Promise<void> {
  const directory = process.env.AI_1667_WEB_UI_SCREENSHOTS;
  if (directory === undefined) return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: `${directory}/web-local-server-preset-${name}.png`, animations: "disabled" });
}

test("a local server keeps its provider on another port, so its banned strings save", async () => {
  const llama = await llamaServer();
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const api = await openInspectionApi(web);
  browser ??= await launchChrome();
  const page = await openTestPage(browser, { viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(8_000);
  await page.goto(web.url);
  await page.getByRole("button", { name: /^Settings \(,\)/ }).click();
  await page.getByRole("group", { name: "Settings view" }).getByRole("button", { name: "Advanced" }).click();
  await page.getByRole("heading", { name: "Sampling", level: 2 }).waitFor();

  // KoboldCpp first, the way the writer had it: banned strings save there.
  await chooseProvider(page, "KoboldCpp", llama.baseUrl);
  await page.getByLabel("Banned strings", { exact: true }).fill("shivers");
  await save(page);
  expect((await savedRoute(api)).connection.preset).toBe("koboldcpp");

  // Then llama.cpp on the same non-default port. The choice stays, the one
  // listed model replaces the old name, and the banned strings still save.
  await chooseProvider(page, "llama.cpp", llama.baseUrl);
  expect(await page.getByRole("button", { name: /^Provider/ }).textContent()).toContain("llama.cpp");
  expect(await page.getByRole("combobox", { name: "Model" }).inputValue()).toBe(SERVED_MODEL);
  await save(page);
  const llamaRoute = await savedRoute(api);
  expect(llamaRoute.connection.preset).toBe("llama-cpp");
  expect(llamaRoute.connection.baseUrl).toBe(llama.baseUrl);
  expect(llamaRoute.model.remoteId).toBe(SERVED_MODEL);
  expect(llamaRoute.profile.sampling?.bannedStrings).toEqual(["shivers"]);
  expect(llama.tokenized).toContain("shivers");
  await screenshot(page, "llama-cpp");

  // A generic choice drops the local preset, so it cannot take the list.
  await chooseProvider(page, "OpenAI-compatible", llama.baseUrl);
  await page.keyboard.press("ControlOrMeta+s");
  await page.getByText(/banned strings is unavailable · not supported by provider/).waitFor();
  expect((await savedRoute(api)).connection.preset).toBe("llama-cpp");
  await screenshot(page, "generic-refused");
}, 90_000);
