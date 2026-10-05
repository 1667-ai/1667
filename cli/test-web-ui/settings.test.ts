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

  // The palette opens it too.
  await page.keyboard.press(":");
  await page.getByRole("dialog", { name: "Command palette" }).waitFor();
  await page.keyboard.type("settings");
  await page.keyboard.press("Enter");
  await waitForHash(page, /^#\/settings$/);
  await page.keyboard.press("Escape");
  await waitForHash(page, /^(#\/?)?$/);

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
  for (const advanced of ["Temperature", "Profile", "Max tokens", "Routing", "Sampling"]) {
    expect(await page.getByText(advanced, { exact: true }).count()).toBe(0);
  }
  await page.getByRole("group", { name: "Settings view" }).getByRole("button", { name: "Simple" }).waitFor();

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

async function openAdvancedSettings(page: Page): Promise<void> {
  await openSettingsPage(page);
  await page.getByRole("group", { name: "Settings view" }).getByRole("button", { name: "Advanced" }).click();
  await page.getByRole("heading", { name: "Generation", level: 2 }).waitFor();
}

const chooseFrom = async (page: Page, name: RegExp | string, option: string): Promise<void> => {
  await page.getByRole("button", { name }).click();
  await page.getByRole("menuitemradio", { name: option, exact: true }).click();
};

test("case 3b: the advanced view shows the extra sections and a section list, and the choice survives a reload", async () => {
  const { page } = await openLibrary();
  await openAdvancedSettings(page);

  expect(await page.getByRole("heading", { level: 2 }).allTextContents()).toEqual(
    ["Display", "Prompts", "Connection", "Model", "Generation", "Sampling", "Thoughts", "Routing"]
  );
  for (const label of ["Rewrite guidance", "Title guidance", "Summary guidance", "Aside guidance", "Temperature", "Max tokens"]) {
    await page.getByLabel(label, { exact: true }).waitFor();
  }
  for (const label of ["Profile", "Effort", "Alternatives", "Prompt cache", "Reasoning display", "Default profile", "Prose profile", "Utility profile"]) {
    await page.getByRole("button", { name: new RegExp(`^${label}`) }).waitFor();
  }
  for (const label of ["Header timeout", "Idle timeout", "Total timeout", "Profile name"]) {
    await page.getByLabel(label, { exact: true }).waitFor();
  }
  await page.getByRole("group", { name: "Prompt layout" }).waitFor();
  await page.getByRole("group", { name: "Save thoughts" }).waitFor();
  await page.getByText("Image input", { exact: true }).waitFor();

  // The section list jumps to a section.
  const rail = page.getByRole("navigation", { name: "Sections" });
  await rail.getByRole("button", { name: "Routing" }).click();
  expect(await page.getByRole("heading", { name: "Routing", level: 2 }).evaluate((element) => {
    const top = element.getBoundingClientRect().top;
    return top >= 0 && top < innerHeight / 2;
  })).toBeTrue();

  await page.reload();
  await page.getByRole("heading", { name: "Generation", level: 2 }).waitFor();
  await page.getByRole("group", { name: "Settings view" }).getByRole("button", { name: "Simple" }).click();
  await page.getByRole("heading", { name: "Generation", level: 2 }).waitFor({ state: "detached" });
  await page.reload();
  await page.getByLabel("Author brief", { exact: true }).waitFor();
  expect(await page.getByRole("heading", { name: "Generation", level: 2 }).count()).toBe(0);
  expect(await rail.count()).toBe(0);
}, 90_000);

test("case 12: profiles are added, renamed, routed and deleted; the last one stays", async () => {
  const { api, page } = await openLibrary();
  await openAdvancedSettings(page);

  // One profile: it cannot be deleted.
  const deleteButton = page.getByRole("button", { name: /^Delete/ });
  await deleteButton.click();
  await deleteButton.click();
  await page.getByText("Profile kept. The last profile cannot be removed.").waitFor();

  await page.getByRole("button", { name: "New profile" }).click();
  await page.getByLabel("Profile name", { exact: true }).fill("Fast drafts");
  await chooseFrom(page, /^Prose profile/, "Fast drafts");
  await saveBar(page).waitFor();
  await saveWithKeyboard(page);

  const saved = (await settingsOf(api)).document!;
  const fast = Object.entries(saved.profiles).find(([, profile]) => profile.name === "Fast drafts");
  expect(fast).toBeDefined();
  expect(saved.routing.prose).toBe(fast![0]);
  expect(Object.keys(saved.profiles).length).toBe(2);

  // A name another profile has is refused with its reason.
  const other = Object.values(saved.profiles).find((profile) => profile.name !== "Fast drafts")!.name;
  await page.getByLabel("Profile name", { exact: true }).fill(other);
  await page.getByText("profile names must be unique").waitFor();
  expect(await saveButton(page).isDisabled()).toBeTrue();
  await page.getByLabel("Profile name", { exact: true }).fill("Fast drafts");
  expect(await saveButton(page).count()).toBe(0);

  // The second click deletes; the routes that used the profile are repaired.
  await deleteButton.click();
  await page.getByRole("button", { name: "Delete? Click again" }).click();
  await saveBar(page).waitFor();
  await saveWithKeyboard(page);
  const after = (await settingsOf(api)).document!;
  expect(Object.keys(after.profiles).length).toBe(1);
  expect(after.routing.prose).toBeUndefined();
}, 90_000);

test("case 12b: rows that do not apply are off and show why", async () => {
  const { page } = await openLibrary();
  await openAdvancedSettings(page);

  expect(await page.getByRole("button", { name: /^Prompt format/ }).isDisabled()).toBeTrue();
  expect(await page.getByText("Available with text-completion providers.").count()).toBe(2);
  expect(await page.getByRole("group", { name: "Split thoughts" }).getByRole("button", { name: "On" }).isDisabled()).toBeTrue();
  expect(await page.getByRole("button", { name: /^Effort/ }).isDisabled()).toBeTrue();
  await page.getByText("This model does not support reasoning effort.").waitFor();

  // Choosing a text-completion provider turns the two connection rows on.
  await chooseFrom(page, /^Provider/, "OpenAI-compatible text");
  expect(await page.getByRole("button", { name: /^Prompt format/ }).isDisabled()).toBeFalse();
  expect(await page.getByText("Available with text-completion providers.").count()).toBe(0);

  // A provider with no alternative token data says so.
  await chooseFrom(page, /^Provider/, "Anthropic");
  expect(await page.getByRole("button", { name: /^Alternatives/ }).isDisabled()).toBeTrue();
  await page.getByText("This provider does not offer alternative token data.").waitFor();
}, 90_000);

test("case 12c: temperature, effort and the other advanced values are saved", async () => {
  const { api, page } = await openLibrary();
  // A model that supports reasoning effort, set up through the API.
  const view = await settingsOf(api);
  const original = view.document!;
  const modelId = original.profiles[original.routing.default]!.modelId;
  const document = {
    ...original,
    models: {
      ...original.models,
      [modelId]: {
        ...original.models[modelId]!,
        capabilities: { ...original.models[modelId]!.capabilities, reasoningEffort: "supported" as const }
      }
    }
  };
  await api.saveSettings({
    transportOperationId: crypto.randomUUID(),
    mutationId: createDurableMutationId(),
    expectedStateGeneration: view.stateGeneration!,
    document
  });
  await page.reload();
  await page.getByRole("button", { name: "New story" }).waitFor();
  await openAdvancedSettings(page);

  await page.getByLabel("Temperature", { exact: true }).fill("0.4");
  await page.getByLabel("Max tokens", { exact: true }).fill("900");
  await chooseFrom(page, /^Effort/, "high");
  await page.getByRole("group", { name: "Prompt layout" }).getByRole("button", { name: "On" }).click();
  await page.getByRole("group", { name: "Save thoughts" }).getByRole("button", { name: "Off" }).click();
  await page.getByLabel("Total timeout", { exact: true }).fill("900");
  await page.getByLabel("Idle timeout", { exact: true }).fill("45");
  await page.getByLabel("Rewrite guidance", { exact: true }).fill("Keep the rewrite close to the original.");
  await saveWithKeyboard(page);

  const saved = (await settingsOf(api)).document!;
  const profile = saved.profiles[saved.routing.default]!;
  expect(profile.temperature).toBe(0.4);
  expect(profile.maxOutputTokens).toBe(900);
  expect(profile.generationReasoning.effort).toBe("high");
  expect(profile.continuationPromptOptimization).toBe("late-cache-stable");
  expect(profile.discardReasoning).toBe(true);
  const model = saved.models[profile.modelId]!;
  expect(saved.connections[model.connectionId]!.timeouts.idleMs).toBe(45_000);
  expect(saved.connections[model.connectionId]!.timeouts.totalMs).toBe(900_000);
  expect(saved.writing.rewriteGuidance).toBe("Keep the rewrite close to the original.");

  // A value past a limit shows its reason and keeps Save off.
  await page.getByLabel("Temperature", { exact: true }).fill("9");
  await page.getByText(/max is 2/).waitFor();
  expect(await saveButton(page).isDisabled()).toBeTrue();
  await page.getByLabel("Temperature", { exact: true }).fill("");
  await page.getByLabel("Idle timeout", { exact: true }).fill("0");
  await page.getByText(/min is/).waitFor();
}, 120_000);

test("case 12d: a key, a refused name and an edit belong to their own profile", async () => {
  const { api, page } = await openLibrary();
  await openAdvancedSettings(page);
  await chooseFrom(page, /^Provider/, "OpenAI");
  await page.getByLabel("API key", { exact: true }).fill(KEY);
  await page.getByText(/not saved yet/).waitFor();

  // A second profile starts with an empty key field.
  await page.getByRole("button", { name: "Duplicate" }).click();
  await page.getByLabel("Profile name", { exact: true }).waitFor();
  expect(await page.getByLabel("API key", { exact: true }).inputValue()).toBe("");
  await page.getByLabel("API key", { exact: true }).fill("x");
  await page.getByLabel("API key", { exact: true }).fill("");
  expect(await page.content()).not.toContain(KEY);

  // A refused name waits for its profile, and a selection that changes nothing keeps it.
  const profileButton = page.getByRole("button", { name: /^Profile / });
  const nameField = page.getByLabel("Profile name", { exact: true });
  await nameField.fill("Default");
  await page.getByText("profile names must be unique").waitFor();
  await profileButton.click();
  await page.getByRole("menuitemradio", { name: "Default copy", exact: true }).click();
  await page.getByText("profile names must be unique").waitFor();
  await profileButton.click();
  await page.getByRole("menuitemradio", { name: "Default", exact: true }).click();
  expect(await page.getByText("profile names must be unique").count()).toBe(0);
  await profileButton.click();
  await page.getByRole("menuitemradio", { name: "Default copy", exact: true }).click();
  await page.getByText("profile names must be unique").waitFor();
  await nameField.fill("Copy of default");
  await page.getByText("profile names must be unique").waitFor({ state: "detached" });

}, 120_000);

test("case 12e: an edit of a duplicated profile does not reach the original", async () => {
  const { api, page } = await openLibrary();
  await openAdvancedSettings(page);
  await page.getByRole("button", { name: "Duplicate" }).click();
  await page.getByLabel("Profile name", { exact: true }).fill("Copy of default");
  // A timeout edit on the copy leaves the original alone.
  await page.getByLabel("Total timeout", { exact: true }).fill("900");
  await page.getByLabel("Idle timeout", { exact: true }).fill("45");
  await page.keyboard.press("ControlOrMeta+s");
  await page.getByText("Settings saved", { exact: true }).waitFor();
  const saved = (await settingsOf(api)).document!;
  const copy = Object.values(saved.profiles).find((profile) => profile.name === "Copy of default")!;
  const original = Object.values(saved.profiles).find((profile) => profile.name !== "Copy of default")!;
  expect(saved.connections[saved.models[copy.modelId]!.connectionId]!.timeouts.idleMs).toBe(45_000);
  expect(saved.connections[saved.models[original.modelId]!.connectionId]!.timeouts.idleMs).not.toBe(45_000);
}, 120_000);

test("case 13: sampling knobs show why they are off, and a server that takes them saves them", async () => {
  const fake = await fakeModelServer();
  const { api, page } = await openLibrary();
  await openAdvancedSettings(page);

  // Dry-run takes no sampling: each knob says why.
  expect(await page.getByLabel("Top p", { exact: true }).isDisabled()).toBeTrue();
  expect(await page.getByLabel("Stop sequences", { exact: true }).isDisabled()).toBeTrue();
  expect(await page.getByRole("heading", { name: "Sampling", level: 2 }).count()).toBe(1);

  await configureFakeServer(page, fake);
  expect(await page.getByLabel("Top p", { exact: true }).isDisabled()).toBeFalse();
  await page.getByLabel("Top p", { exact: true }).fill("0.9");
  await page.getByLabel("Stop sequences", { exact: true }).fill("###\nTHE END");
  await page.getByLabel("Top p", { exact: true }).fill("5");
  await page.getByText(/must be/).first().waitFor();
  expect(await saveButton(page).isDisabled()).toBeTrue();
  await page.getByLabel("Top p", { exact: true }).fill("0.9");
  await saveWithKeyboard(page);

  const saved = (await settingsOf(api)).document!;
  const profile = saved.profiles[saved.routing.default]!;
  expect(profile.sampling?.topP).toBe(0.9);
  expect(profile.sampling?.stop).toEqual(["###", "THE END"]);
}, 120_000);

test("case 13b: a starter profile is added as a new profile and saved", async () => {
  const { api, page } = await openLibrary();
  await openAdvancedSettings(page);
  await page.getByRole("button", { name: "From starter" }).click();
  await page.getByRole("menuitem", { name: "conservative", exact: true }).click();
  await page.getByText(/Added "conservative" with \d+ of \d+ values/).waitFor();
  expect(await page.getByLabel("Profile name", { exact: true }).inputValue()).toBe("conservative");
  await saveWithKeyboard(page);
  const saved = (await settingsOf(api)).document!;
  expect(Object.values(saved.profiles).some((profile) => profile.name === "conservative")).toBeTrue();
  expect(Object.keys(saved.profiles).length).toBe(2);
}, 90_000);

test("case 13c: a story's own phrase bias is saved for the story from the settings page", async () => {
  const { api, page } = await openLibrary();
  const forked = await seedForkedStory(api);
  await page.reload();
  await page.getByRole("button", { name: /^Forked Story/ }).click();
  await page.getByRole("heading", { name: "Forked Story", level: 1 }).waitFor();
  await page.keyboard.press(",");
  await page.getByRole("group", { name: "Settings view" }).getByRole("button", { name: "Advanced" }).click();
  await page.getByRole("heading", { name: "This story", level: 2 }).waitFor();

  await page.getByLabel("Phrase bias", { exact: true }).last().fill("delve: -50\nmoreover: -20");
  await page.getByRole("button", { name: "Save phrase bias for this story" }).click();
  await page.getByText("Phrase bias saved for this story").waitFor();
  expect((await api.loadStory(forked.storyId)).phraseBias).toEqual([
    { phrase: "delve", weight: -50 },
    { phrase: "moreover", weight: -20 }
  ]);

  // A line that does not read phrase: weight is refused, and Save stays off.
  await page.getByLabel("Phrase bias", { exact: true }).last().fill("delve");
  await page.getByText(/must read/).waitFor();
  expect(await page.getByRole("button", { name: "Save phrase bias for this story" }).isDisabled()).toBeTrue();

  // From the Library the section is not there.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
}, 120_000);

test("case 13d: a stop sequence that is a newline survives an edit of another entry", async () => {
  const fake = await fakeModelServer();
  const { api, page } = await openLibrary();
  await openAdvancedSettings(page);
  await configureFakeServer(page, fake);
  const stop = page.getByLabel("Stop sequences", { exact: true });
  await stop.fill("\\n\n:");
  await saveWithKeyboard(page);
  const profileOf = async () => {
    const document = (await settingsOf(api)).document!;
    return document.profiles[document.routing.default]!;
  };
  expect((await profileOf()).sampling?.stop).toEqual(["\n", ":"]);

  expect(await stop.inputValue()).toBe("\\n\n:");
  await stop.fill("\\n\n;");
  await saveWithKeyboard(page);
  expect((await profileOf()).sampling?.stop).toEqual(["\n", ";"]);
}, 120_000);

test("case 13e: a refused name of another profile still blocks Save", async () => {
  const { page } = await openLibrary();
  await openAdvancedSettings(page);
  await page.getByRole("button", { name: "Duplicate" }).click();
  await page.getByLabel("Profile name", { exact: true }).fill("Default");
  await page.getByText("profile names must be unique").waitFor();
  await page.getByRole("button", { name: /^Profile / }).click();
  await page.getByRole("menuitemradio", { name: "Default", exact: true }).click();
  await page.getByLabel("Temperature", { exact: true }).fill("0.5");
  await saveBar(page).getByText(/Fix 1 field/).waitFor();
  expect(await saveButton(page).isDisabled()).toBeTrue();
}, 90_000);

test("case 13f: unsaved story lists stay when the view changes, and Esc leaves the field", async () => {
  const { api, page } = await openLibrary();
  await seedForkedStory(api);
  await page.reload();
  await page.getByRole("button", { name: /^Forked Story/ }).click();
  await page.getByRole("heading", { name: "Forked Story", level: 1 }).waitFor();
  await page.keyboard.press(",");
  const view = page.getByRole("group", { name: "Settings view" });
  await view.getByRole("button", { name: "Advanced" }).click();
  await page.getByRole("heading", { name: "This story", level: 2 }).waitFor();
  const field = page.getByLabel("Banned strings", { exact: true }).last();
  await field.fill("however");
  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("TEXTAREA");
  expect(page.url()).toContain("settings");

  await view.getByRole("button", { name: "Simple" }).click();
  await view.getByRole("button", { name: "Advanced" }).click();
  await page.getByRole("heading", { name: "This story", level: 2 }).waitFor();
  expect(await page.getByLabel("Banned strings", { exact: true }).last().inputValue()).toBe("however");

  await page.keyboard.press("Escape");
  await waitForHash(page, /^#\/story\//);
  await page.keyboard.press(",");
  await page.getByRole("heading", { name: "This story", level: 2 }).waitFor();
  expect(await page.getByLabel("Banned strings", { exact: true }).last().inputValue()).toBe("however");
}, 120_000);
