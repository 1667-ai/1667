import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createServer as createSecureServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Locator, Page } from "playwright-core";
import type { StoryApi } from "../../client/api.js";
import { createDurableMutationId } from "../../shared/durable-mutation-id.js";
import { DRY_RUN_WORD_DELAY_VARIABLE } from "../../server/providers.js";
import { ownedLoopbackHttpSupported } from "../../server/provider-fetch.js";
import { cleanupWebProcesses, scratchProject, spawnWeb, type ReadyWeb } from "../test/web-e2e-fixture.js";
import {
  afterAllHook,
  cleanupWebUiPages,
  launchChrome,
  openInspectionApi,
  openTestPage,
  seedForkedStory
} from "./web-ui-fixture.js";
import type { Browser } from "playwright-core";

/**
 * The settings page in a real browser (#409 step 9b): the way in and out, the
 * simple view, saving, a model server on this machine, the write-only API key,
 * a conflict, a draft that survives leaving the page, an activation that does
 * not take, a save while a generation runs, and refused values.
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

const KEY = "sk-test-SECRET-4f9c2a71b8e0d3";

/** A model server on this machine that speaks the OpenAI-compatible API. It
 * records the Authorization header of every request. A key can only travel to
 * an HTTPS server, so `tls` serves a certificate made for this run; the web
 * server must trust it (`caFile`, for NODE_EXTRA_CA_CERTS). */
interface FakeServer {
  baseUrl: string;
  readonly authorizations: (string | undefined)[];
  unauthorized: boolean;
  caFile: string;
}

async function fakeModelServer(tls = false): Promise<FakeServer> {
  const fake: FakeServer = { baseUrl: "", authorizations: [], unauthorized: false, caFile: "" };
  const handler: Parameters<typeof createServer>[1] = (request, response) => {
    fake.authorizations.push(request.headers.authorization);
    if (fake.unauthorized) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "bad key" } }));
      return;
    }
    if (request.method === "GET" && request.url === "/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "fake-model-a" }, { id: "fake-model-b" }] }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(['data: {"choices":[{"delta":{"content":" sample"}}]}', "", "data: [DONE]", "", ""].join("\n"));
      return;
    }
    response.writeHead(404).end();
  };
  let server: Server;
  if (tls) {
    const dir = await mkdtemp(path.join(tmpdir(), "1667-web-tls-"));
    const key = path.join(dir, "key.pem");
    fake.caFile = path.join(dir, "cert.pem");
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", fake.caFile, "-days", "2",
      "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"
    ], { stdio: "ignore" });
    server = createSecureServer({ key: await readFile(key), cert: await readFile(fake.caFile) }, handler);
  } else {
    server = createServer(handler);
  }
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fake.baseUrl = `${tls ? "https" : "http"}://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return fake;
}

interface Opened {
  readonly web: ReadyWeb;
  readonly api: StoryApi;
  readonly page: Page;
}

async function openLibrary(env: Record<string, string> = {}): Promise<Opened> {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], { ...project.env, ...env });
  const api = await openInspectionApi(web);
  const page = await openTestPage(await sharedBrowser());
  await page.goto(web.url);
  await page.getByRole("button", { name: "New story" }).waitFor();
  return { web, api, page };
}

async function openSettingsPage(page: Page): Promise<void> {
  await page.getByRole("button", { name: /^Settings \(,\)/ }).click();
  await page.getByRole("heading", { name: "Settings", level: 1 }).waitFor();
  await page.getByLabel("Author brief", { exact: true }).waitFor();
}

async function waitForHash(page: Page, expected: RegExp): Promise<void> {
  try {
    await page.waitForFunction((source) => new RegExp(source).test(location.hash), expected.source, { timeout: 8_000 });
  } catch (error) {
    throw new Error(`expected hash ${expected} but it is ${await page.evaluate(() => location.hash)}`, { cause: error });
  }
}

async function markDocument(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { documentMark?: string }).documentMark = "still here";
  });
}

async function documentKept(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as unknown as { documentMark?: string }).documentMark === "still here");
}

const saveBar = (page: Page): Locator => page.getByRole("region", { name: "Settings changes" });
const saveButton = (page: Page): Locator => saveBar(page).getByRole("button", { name: "Save", exact: true });

async function leaveField(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/** Saves with the keyboard and waits for the bar to go. */
async function saveWithKeyboard(page: Page): Promise<void> {
  await page.keyboard.press("ControlOrMeta+s");
  await page.getByText("Settings saved", { exact: true }).waitFor();
  await saveBar(page).waitFor({ state: "detached" });
}

/** Points the page at the fake server: the provider, the address, and the
 * first model it lists. A system that cannot prove who owns a local port also
 * needs the plain HTTP opt-in. */
async function configureFakeServer(page: Page, fake: FakeServer): Promise<void> {
  await page.getByRole("button", { name: /^Provider/ }).click();
  await page.getByRole("menuitemradio", { name: "OpenAI-compatible", exact: true }).click();
  await page.getByLabel("Base URL", { exact: true }).fill(fake.baseUrl);
  if (fake.baseUrl.startsWith("http:") && !ownedLoopbackHttpSupported()) {
    await page.getByRole("group", { name: "Plain HTTP" }).getByRole("button", { name: "On" }).click();
  }
  await page.getByRole("combobox", { name: "Model" }).click();
  await page.getByRole("option", { name: /^fake-model-a/ }).click();
}

async function settingsOf(api: StoryApi) {
  return await api.getSettings();
}

test("case 1: `,` opens the page, Esc and Back close it, Forward reopens it, and the map ignores `,`", async () => {
  const { api, page } = await openLibrary();
  const forked = await seedForkedStory(api);
  await page.reload();
  await page.getByRole("button", { name: "New story" }).waitFor();
  await markDocument(page);

  await page.keyboard.press(",");
  await waitForHash(page, /^#\/settings$/);
  await page.getByRole("heading", { name: "Settings", level: 1 }).waitFor();
  await page.keyboard.press("Escape");
  await waitForHash(page, /^(#\/?)?$/);
  await page.getByRole("button", { name: "New story" }).waitFor();

  await page.getByRole("button", { name: /^Forked Story/ }).click();
  await page.getByRole("heading", { name: "Forked Story", level: 1 }).waitFor();
  await page.locator(".part").first().click();
  await page.keyboard.press(",");
  await waitForHash(page, /^#\/settings$/);
  await page.getByRole("heading", { name: "Settings", level: 1 }).waitFor();
  await page.goBack();
  await waitForHash(page, new RegExp(`^#/story/${forked.storyId}$`));
  await page.getByRole("heading", { name: "Forked Story", level: 1 }).waitFor();
  await page.goForward();
  await waitForHash(page, /^#\/settings$/);
  await page.getByRole("heading", { name: "Settings", level: 1 }).waitFor();
  await page.goBack();
  await page.getByRole("heading", { name: "Forked Story", level: 1 }).waitFor();

  // A comma typed into the composer is a comma.
  await page.keyboard.press("i");
  const composer = page.getByRole("textbox", { name: "What happens next?" });
  await composer.press(",");
  expect(await composer.inputValue()).toBe(",");
  expect(page.url()).not.toContain("settings");
  await composer.fill("");
  await page.keyboard.press("Escape");

  // The map has no `,`.
  await page.getByRole("button", { name: "Map (m)" }).click();
  await page.getByRole("listbox", { name: "Story map" }).waitFor();
  await page.keyboard.press(",");
  await page.getByRole("listbox", { name: "Story map" }).waitFor();
  expect(page.url()).toContain("/map");

  expect(await documentKept(page)).toBeTrue();
}, 60_000);

test("case 2: the sidebar gear opens the page; at 700px nothing scrolls sideways and the Save bar shows", async () => {
  const { page } = await openLibrary();
  const gear = page.getByRole("button", { name: /^Settings \(,\)/ });
  expect(await gear.getAttribute("title")).toBe("Settings (,)");
  await gear.click();
  await page.getByRole("heading", { name: "Settings", level: 1 }).waitFor();

  await page.setViewportSize({ width: 700, height: 900 });
  await page.getByLabel("Author brief", { exact: true }).fill("A brief typed at a narrow width.");
  await saveBar(page).waitFor();
  const metrics = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    inner: window.innerWidth,
    barBottom: document.querySelector(".settings-bar")!.getBoundingClientRect().bottom,
    height: window.innerHeight,
    bodyScroll: document.querySelector(".settings-scroll")!.scrollWidth,
    bodyClient: document.querySelector(".settings-scroll")!.clientWidth
  }));
  expect(metrics.scroll <= metrics.inner).toBeTrue();
  expect(metrics.bodyScroll <= metrics.bodyClient).toBeTrue();
  expect(metrics.barBottom <= metrics.height).toBeTrue();
  await saveButton(page).waitFor();
}, 60_000);

test("case 3: the simple view shows the simple rows and nothing more", async () => {
  const { page } = await openLibrary();
  await page.keyboard.press(",");
  await page.getByRole("heading", { name: "Settings", level: 1 }).waitFor();

  const headings = await page.getByRole("heading", { level: 2 }).allTextContents();
  expect(headings).toEqual(["Display", "Prompts", "Connection", "Model"]);
  await page.getByRole("button", { name: /^Provider/ }).waitFor();
  await page.getByLabel("Base URL", { exact: true }).waitFor();
  await page.getByLabel("API key", { exact: true }).waitFor();
  await page.getByRole("combobox", { name: "Model" }).waitFor();
  await page.getByLabel("Context size", { exact: true }).waitFor();
  await page.getByLabel("Author brief", { exact: true }).waitFor();
  await page.getByLabel("Continue direction", { exact: true }).waitFor();
  await page.getByRole("group", { name: "Palette" }).waitFor();
  await page.getByRole("group", { name: "Theme" }).waitFor();
  await page.getByRole("group", { name: "Show directions" }).waitFor();
  for (const advanced of ["Temperature", "Profile", "Max tokens", "Routing", "Sampling", "Simple", "Advanced"]) {
    expect(await page.getByText(advanced, { exact: true }).count()).toBe(0);
  }

  // The display choices apply at once.
  await page.getByRole("group", { name: "Theme" }).getByRole("button", { name: "Dark" }).click();
  expect(await page.evaluate(() => document.documentElement.getAttribute("data-theme"))).toBe("dark");
  await page.getByRole("group", { name: "Palette" }).getByRole("button", { name: "Grove" }).click();
  expect(await page.evaluate(() => document.documentElement.getAttribute("data-palette"))).toBe("grove");
  expect(await saveBar(page).count()).toBe(0);
}, 60_000);

test("case 4: a changed brief saves with the keyboard", async () => {
  const { api, page } = await openLibrary();
  await openSettingsPage(page);
  await page.getByLabel("Author brief", { exact: true }).fill("Write in short, plain sentences.");
  await saveBar(page).getByText("1 change").waitFor();
  await saveWithKeyboard(page);
  expect((await settingsOf(api)).document!.writing.defaultAuthorBrief).toBe("Write in short, plain sentences.");
  expect(await page.getByLabel("Author brief", { exact: true }).inputValue()).toBe("Write in short, plain sentences.");
}, 60_000);

test("case 5: a model server on this machine lists its models, checks, and saves", async () => {
  const fake = await fakeModelServer();
  const { api, page } = await openLibrary();
  await openSettingsPage(page);
  await configureFakeServer(page, fake);
  expect(await page.getByRole("combobox", { name: "Model" }).inputValue()).toBe("fake-model-a");

  await page.getByRole("button", { name: "Check", exact: true }).click();
  await page.getByText(/Server is ready/).waitFor();
  await saveWithKeyboard(page);

  const view = await settingsOf(api);
  const document = view.document!;
  const profile = document.profiles[document.routing.default]!;
  const model = document.models[profile.modelId]!;
  const connection = document.connections[model.connectionId]!;
  expect(connection.baseUrl).toBe(fake.baseUrl);
  expect(connection.protocol).toBe("openai-chat-completions");
  expect(model.remoteId).toBe("fake-model-a");
}, 90_000);

test("case 6: a typed API key stays out of the page, the storage and the Copy text", async () => {
  const fake = await fakeModelServer(true);
  const { web, page } = await openLibrary({ NODE_EXTRA_CA_CERTS: fake.caFile });
  await openSettingsPage(page);
  await configureFakeServer(page, fake);
  await saveWithKeyboard(page);

  const keyField = page.getByLabel("API key", { exact: true });
  await keyField.fill(KEY);
  await page.getByText(/not saved yet/).waitFor();
  expect(await page.content()).not.toContain(KEY);
  await page.getByLabel("Author brief", { exact: true }).fill("A brief changed with a key pending.");
  await saveBar(page).getByText("2 changes").waitFor();

  // While the page is unsaved, a lost connection lists the changed prompt for
  // Copy. The key is not in it, or anywhere in the page.
  web.child.kill("SIGKILL");
  await web.exit;
  const work = page.getByRole("region", { name: "Unsaved work" });
  await work.waitFor({ timeout: 10_000 });
  const copyText = await work.getByRole("textbox", { name: "Unsaved settings" }).inputValue();
  expect(copyText).toContain("A brief changed with a key pending.");
  expect(copyText).not.toContain(KEY);
  expect(await page.content()).not.toContain(KEY);
  expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage, location.href]))).not.toContain(KEY);
}, 90_000);

test("case 6b: after a save the key row says Stored, Check sends the key, and Remove clears it", async () => {
  const fake = await fakeModelServer(true);
  const { api, page } = await openLibrary({ NODE_EXTRA_CA_CERTS: fake.caFile });
  await openSettingsPage(page);
  await configureFakeServer(page, fake);
  await saveWithKeyboard(page);

  await page.getByLabel("API key", { exact: true }).fill(KEY);
  await saveWithKeyboard(page);

  const toastsAndPage = await page.content();
  expect(toastsAndPage).not.toContain(KEY);
  expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage, location.href]))).not.toContain(KEY);
  const view = await settingsOf(api);
  const document = view.document!;
  const model = document.models[document.profiles[document.routing.default]!.modelId]!;
  expect(document.connections[model.connectionId]!.auth.type).toBe("bearer-stored");
  expect(JSON.stringify(view)).not.toContain(KEY);

  await page.reload();
  await page.getByLabel("Author brief", { exact: true }).waitFor();
  expect(await page.getByLabel("API key", { exact: true }).inputValue()).toBe("");
  await page.getByText("Stored", { exact: true }).waitFor();
  expect(await page.content()).not.toContain(KEY);

  fake.authorizations.length = 0;
  await page.getByRole("button", { name: "Check", exact: true }).click();
  await page.getByText(/Server is ready/).waitFor();
  expect(fake.authorizations).toContain(`Bearer ${KEY}`);

  // A refused key does not keep Save off once the stored key is removed.
  await page.getByLabel("API key", { exact: true }).fill(" spaced ");
  expect(await saveButton(page).isDisabled()).toBeTrue();
  await page.getByRole("button", { name: "Remove" }).click();
  expect(await saveButton(page).isDisabled()).toBeFalse();
  await saveWithKeyboard(page);
  const removed = (await settingsOf(api)).document!;
  const removedModel = removed.models[removed.profiles[removed.routing.default]!.modelId]!;
  expect(removed.connections[removedModel.connectionId]!.auth.type).toBe("none");
  expect(await page.getByText("Stored", { exact: true }).count()).toBe(0);
}, 120_000);

test("case 7: a save refused for a conflict keeps the draft; the next Save overwrites", async () => {
  const { api, page } = await openLibrary();
  await openSettingsPage(page);
  await page.getByLabel("Author brief", { exact: true }).fill("The brief on this page.");

  const view = await settingsOf(api);
  await api.saveSettings({
    transportOperationId: crypto.randomUUID(),
    mutationId: createDurableMutationId(),
    expectedStateGeneration: view.stateGeneration!,
    document: { ...view.document!, writing: { ...view.document!.writing, defaultAuthorBrief: "A brief saved elsewhere." } }
  });

  await saveButton(page).click();
  await saveBar(page).getByText(/changed elsewhere/).waitFor();
  expect(await page.getByLabel("Author brief", { exact: true }).inputValue()).toBe("The brief on this page.");

  await saveWithKeyboard(page);
  expect((await settingsOf(api)).document!.writing.defaultAuthorBrief).toBe("The brief on this page.");
}, 60_000);

test("case 8: a draft survives leaving the page, and a reload warns about it", async () => {
  const { page } = await openLibrary();
  await openSettingsPage(page);
  await page.getByLabel("Author brief", { exact: true }).fill("A draft that is not saved.");
  await leaveField(page);
  await page.keyboard.press("Escape");
  await waitForHash(page, /^(#\/?)?$/);

  const gear = page.getByRole("button", { name: "Settings (,) · unsaved changes" });
  await gear.waitFor();
  await page.keyboard.press(",");
  await page.getByRole("heading", { name: "Settings", level: 1 }).waitFor();
  expect(await page.getByLabel("Author brief", { exact: true }).inputValue()).toBe("A draft that is not saved.");
  await saveBar(page).getByText("1 change").waitFor();

  let sawBeforeUnload = false;
  page.on("dialog", (dialog) => {
    if (dialog.type() === "beforeunload") sawBeforeUnload = true;
    void dialog.accept();
  });
  await page.reload();
  expect(sawBeforeUnload).toBeTrue();
}, 60_000);

test("case 9: settings saved but not active show it, and Discard pending removes them", async () => {
  const fake = await fakeModelServer(true);
  const { api, page } = await openLibrary({ NODE_EXTRA_CA_CERTS: fake.caFile });
  await openSettingsPage(page);
  await configureFakeServer(page, fake);
  await saveWithKeyboard(page);

  fake.unauthorized = true;
  await page.getByLabel("API key", { exact: true }).fill(KEY);
  await page.keyboard.press("ControlOrMeta+s");
  await saveBar(page).getByText(/Saved, not active/).waitFor();
  expect((await settingsOf(api)).pendingRevision).not.toBeNull();
  expect(await page.content()).not.toContain(KEY);

  await saveBar(page).getByRole("button", { name: "Discard pending" }).click();
  await saveBar(page).waitFor({ state: "detached" });
  expect((await settingsOf(api)).pendingRevision).toBeNull();
}, 90_000);

test("case 10: a save during a generation lands, and Esc closes the page without stopping it", async () => {
  const { web, api, page } = await openLibrary({ [DRY_RUN_WORD_DELAY_VARIABLE]: "80" });
  const created = await api.createStory("Slow Story");
  await api.createNode(created.id, { text: "Once upon a time.", parentId: null });
  await page.evaluate((id) => { location.hash = `#/story/${id}`; }, created.id);
  await page.getByRole("heading", { name: "Slow Story", level: 1 }).waitFor();

  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Stop" }).waitFor();
  await page.keyboard.press(",");
  await page.getByRole("heading", { name: "Settings", level: 1 }).waitFor();
  await page.getByRole("button", { name: "Stop" }).waitFor();

  await page.getByLabel("Continue direction", { exact: true }).fill("Go on, slowly.");
  await saveBar(page).getByText(/apply from the next request/).waitFor();
  await saveWithKeyboard(page);
  expect((await settingsOf(api)).document!.writing.defaultContinueDirection).toBe("Go on, slowly.");
  await page.getByRole("button", { name: "Stop" }).waitFor();

  await leaveField(page);
  await page.keyboard.press("Escape");
  await page.getByRole("heading", { name: "Slow Story", level: 1 }).waitFor();
  await page.getByRole("button", { name: "Stop" }).waitFor();
  await page.getByRole("button", { name: "Continue" }).waitFor({ timeout: 20_000 });
  const story = await api.loadStory(created.id);
  expect(story.path.at(-1)!.text.length > "Once upon a time.".length).toBeTrue();
  expect(web.child.exitCode).toBeNull();
}, 90_000);

test("case 11: refused values show their reason and keep Save off", async () => {
  const { page } = await openLibrary();
  await openSettingsPage(page);
  const context = page.getByLabel("Context size", { exact: true });
  await context.fill("0");
  await page.getByText("min is 1", { exact: true }).waitFor();
  await saveBar(page).getByText(/Fix 1 field/).waitFor();
  expect(await saveButton(page).isDisabled()).toBeTrue();

  await context.fill("abc");
  await page.getByText("not a number", { exact: true }).waitFor();
  expect(await saveButton(page).isDisabled()).toBeTrue();

  await context.fill("16384");
  await saveBar(page).getByText("1 change").waitFor();
  expect(await saveButton(page).isDisabled()).toBeFalse();

  const brief = page.getByLabel("Author brief", { exact: true });
  await brief.fill("x".repeat(70_000));
  await page.getByText(/at most 65,536/).waitFor();
  expect(await saveButton(page).isDisabled()).toBeTrue();

  // Refused text is still the writer's: leaving and coming back keeps it.
  await leaveField(page);
  await page.keyboard.press("Escape");
  await waitForHash(page, /^(#\/?)?$/);
  await page.getByRole("button", { name: "Settings (,) · unsaved changes" }).waitFor();
  await page.keyboard.press(",");
  await page.getByLabel("Author brief", { exact: true }).waitFor();
  expect((await brief.inputValue()).length).toBe(70_000);
  await brief.fill("A short brief again.");
  expect(await saveButton(page).isDisabled()).toBeFalse();
}, 60_000);
