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

let browser: Browser | null = null;
const servers: Server[] = [];
afterAllHook(async () => { await browser?.close(); });
afterEach(async () => {
  await cleanupWebUiPages();
  await cleanupWebProcesses();
  for (const server of servers.splice(0)) server.close();
});

async function openPicker(models: string[], discoveryReady: Promise<void> = Promise.resolve()) {
  const catalog = { models, failed: false };
  const server = createServer(async (request, response) => {
    if (request.url === "/v1/models") {
      await discoveryReady;
      response.writeHead(catalog.failed ? 503 : 200, { "content-type": "application/json" });
      response.end(JSON.stringify(catalog.failed ? { error: "Unavailable" } : {
        data: catalog.models.map((id) => ({ id, context_length: 32_768 }))
      }));
      return;
    }
    response.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const api = await openInspectionApi(web);
  browser ??= await launchChrome();
  const page = await openTestPage(browser, { viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(8_000);
  await page.goto(web.url);
  await page.getByRole("button", { name: /^Settings \(,\)/ }).click();
  await page.getByRole("button", { name: /^Provider/ }).click();
  await page.getByRole("menuitemradio", { name: "OpenAI-compatible", exact: true }).click();
  const model = page.getByRole("combobox", { name: "Model" });
  await model.fill("previous-model");
  await page.getByLabel("Base URL", { exact: true }).fill(
    `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  );
  if (!ownedLoopbackHttpSupported()) {
    await page.getByRole("group", { name: "Plain HTTP" }).getByRole("button", { name: "On" }).click();
  }
  return { api, page, model, catalog };
}

async function saveModel(page: Page, api: StoryApi, keyboard = false): Promise<string> {
  const changes = page.getByRole("region", { name: "Settings changes" });
  if (keyboard) await page.keyboard.press("ControlOrMeta+s");
  else await changes.getByRole("button", { name: "Save", exact: true }).click();
  await changes.waitFor({ state: "detached" });
  const dismiss = page.getByRole("button", { name: "Dismiss", exact: true });
  while (await dismiss.count() > 0) await dismiss.first().click();
  const view = await api.getSettings();
  const document = view.document!;
  return document.models[document.profiles[document.routing.default]!.modelId]!.remoteId;
}

async function screenshot(page: Page, name: string): Promise<void> {
  const directory = process.env.AI_1667_WEB_UI_SCREENSHOTS;
  if (directory === undefined) return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: `${directory}/web-model-picker-${name}.png`, animations: "disabled" });
}

test("one listed model replaces a previous model automatically and saves", async () => {
  const { api, page, model, catalog } = await openPicker(["local-model-a"]);
  await page.getByText(/1 model listed/).waitFor();
  expect(await model.inputValue()).toBe("local-model-a");
  expect(await page.getByRole("button", { name: "Choose model", exact: true }).count()).toBe(0);
  await model.click();
  expect(await page.getByRole("listbox", { name: "Models" }).count()).toBe(0);
  expect(await saveModel(page, api)).toBe("local-model-a");

  // A server can load a different model while the settings page stays open.
  catalog.models = ["local-model-b"];
  await page.getByRole("button", { name: "Reload the model list" }).click();
  await page.getByText(/1 model listed/).waitFor();
  expect(await model.inputValue()).toBe("local-model-b");
  expect(await saveModel(page, api)).toBe("local-model-b");
  await screenshot(page, "single");
}, 60_000);

test("automatic selection replaces focused typed text before a keyboard save", async () => {
  let finishDiscovery!: () => void;
  const discoveryReady = new Promise<void>((resolve) => { finishDiscovery = resolve; });
  const { api, page, model } = await openPicker(["local-model-a"], discoveryReady);
  try {
    await model.fill(" typed-model ");
    expect(await model.inputValue()).toBe(" typed-model ");
    finishDiscovery();
    await page.getByText(/1 model listed/).waitFor();
    expect(await model.inputValue()).toBe("local-model-a");
    expect(await model.evaluate((input) => input === document.activeElement)).toBe(true);
    expect(await saveModel(page, api, true)).toBe("local-model-a");
    await screenshot(page, "focused-auto-selection");
  } finally {
    finishDiscovery();
  }
}, 60_000);

test("multiple models have a dropdown despite a previous name, with search and reopening", async () => {
  const { api, page, model } = await openPicker(["local-model-a", "local-model-b"]);
  await page.getByText(/2 models listed/).waitFor();
  expect(await model.inputValue()).toBe("previous-model");
  const choose = page.getByRole("button", { name: "Choose model", exact: true });
  await choose.click();
  expect(await page.getByRole("option").count()).toBe(2);
  await page.getByRole("option", { name: /^local-model-b/ }).click();
  expect(await model.inputValue()).toBe("local-model-b");

  await model.click();
  await page.getByRole("option", { name: /^local-model-a/ }).click();
  await model.click();
  await page.getByRole("option", { name: /^local-model-b/ }).waitFor();
  await model.fill("model-b");
  expect(await page.getByRole("option").count()).toBe(1);
  await page.getByRole("option", { name: /^local-model-b/ }).click();
  expect(await saveModel(page, api)).toBe("local-model-b");

  await choose.click();
  await page.getByRole("option", { name: /^local-model-a/ }).waitFor();
  await screenshot(page, "multiple");
  await page.keyboard.press("Escape");
  expect(await page.getByRole("listbox", { name: "Models" }).count()).toBe(0);
  await model.fill("custom-model");
  await choose.click();
  expect(await page.getByRole("option").count()).toBe(2);
  expect(await model.inputValue()).toBe("custom-model");
  await page.keyboard.press("Escape");
  expect(await saveModel(page, api)).toBe("custom-model");
}, 60_000);

test("an empty or unavailable catalog keeps manual model entry", async () => {
  const { api, page, model, catalog } = await openPicker([]);
  await page.getByText("The server lists no models. Type the model name.").waitFor();
  expect(await page.getByRole("button", { name: "Choose model", exact: true }).count()).toBe(0);
  await model.fill("custom-model");
  expect(await saveModel(page, api)).toBe("custom-model");
  catalog.failed = true;
  await page.getByRole("button", { name: "Reload the model list" }).click();
  await page.getByText(/The model list is not available:/).waitFor();
  expect(await model.inputValue()).toBe("custom-model");
  await model.fill("another-model");
  expect(await saveModel(page, api)).toBe("another-model");
}, 60_000);
