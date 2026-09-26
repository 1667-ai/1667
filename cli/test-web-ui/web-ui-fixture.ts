import * as bunTestRuntime from "bun:test";
import { chromium, type Browser, type BrowserContextOptions, type Page } from "playwright-core";
import type { StoryApi } from "../../client/api.js";
import {
  openWebBridgeTransport,
  webBridgeProtocols,
  webBridgeUrl,
  type WebBridgeTransport
} from "../../client/web-bridge-transport.js";
import { storyApiFromWorkerTransport } from "../../client/worker-story-api.js";
import { BunWebSocket, type ReadyWeb } from "../test/web-e2e-fixture.js";

/**
 * `playwright-core` driving the system Chrome (owner decision), shared by
 * every `cli/test-web-ui/*.test.ts` file. Role/name locators only — never a
 * CSS class selector, which is an implementation detail the design is free
 * to rename.
 */

/**
 * A real Chrome, launched the same way in every test file. `channel: "chrome"`
 * is the owner's decision; `AI_1667_WEB_UI_CHROME` overrides the executable
 * path for a machine (or CI image) where Chrome is not on the channel's
 * usual paths. A missing Chrome fails loudly here — `chromium.launch`'s own
 * error is specific and is never caught or downgraded.
 */
export async function launchChrome(): Promise<Browser> {
  const executablePath = process.env.AI_1667_WEB_UI_CHROME;
  return executablePath === undefined
    ? await chromium.launch({ channel: "chrome" })
    : await chromium.launch({ executablePath });
}

/** `cli/test/setup.ts` casts around the same gap: `tui/src/bun-test.d.ts`'s
 * `bun:test` shim declares only what the TUI suites needed
 * (`describe`/`test`/`afterEach`/`expect`) and has no `afterAll`, though the
 * real runtime does. */
export const afterAllHook = (bunTestRuntime as unknown as {
  afterAll(cleanup: () => void | Promise<void>): void;
}).afterAll;

const openPages: Page[] = [];

/** A fresh context and page (isolated storage) per test, tracked for
 * `cleanupWebUiPages` to close in `afterEach`. */
export async function openTestPage(browser: Browser, options: BrowserContextOptions = {}): Promise<Page> {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  openPages.push(page);
  return page;
}

export async function cleanupWebUiPages(): Promise<void> {
  await Promise.all(openPages.splice(0).map((page) => page.context().close()));
}

/** A second bridge connection, independent of the page under test — for
 * seeding and inspecting story data directly, the same pattern
 * `cli/test/web-bridge-e2e.test.ts` uses for its own assertions. */
export async function openInspectionApi(web: ReadyWeb): Promise<StoryApi> {
  const transport = await openInspectionTransport(web);
  return storyApiFromWorkerTransport(transport);
}

export async function openInspectionTransport(web: ReadyWeb): Promise<WebBridgeTransport> {
  const socket = new BunWebSocket(webBridgeUrl({ host: `127.0.0.1:${web.port}` }), {
    protocols: webBridgeProtocols(web.token),
    headers: { origin: web.origin }
  });
  const { transport } = await openWebBridgeTransport(socket);
  return transport;
}

/** Console errors and CSP violations collected from page load onward — case
 * 1's "no CSP violations" check, reused by every test that also wants a
 * clean console. Installed with `addInitScript` so it is armed before any
 * page script runs, on every navigation in this page's lifetime. */
export interface PageDiagnostics {
  readonly consoleErrors: string[];
  readonly cspViolations: string[];
}

export interface ForkedStory {
  readonly storyId: string;
  readonly a1: string;
  readonly b1: string;
  readonly c1: string;
  readonly b2: string;
  readonly c2: string;
  readonly b3: string;
  readonly breakId: string | null;
}

/**
 * `manuscript.test.ts`'s shared fixture (#409 step 4): a story shaped
 * `A1 → B1 → C1`, a sibling fork `B2` (parent `A1`) `→ C2`, a childless
 * sibling `B3` (parent `A1`), an optional chapter break anchored on `B1`,
 * ending with the active line switched back to `C1` (so opening the story
 * reads `A1, B1, C1` with `B1`/`B2`/`B3` as three takes of the same part).
 */
export async function seedForkedStory(
  api: StoryApi,
  options: { readonly chapterBreakTitle?: string } = {}
): Promise<ForkedStory> {
  const created = await api.createStory("Forked Story");
  const storyId = created.id;
  const pA1 = await api.createNode(storyId, { text: "A1: the opening part of the story.", parentId: null });
  const a1 = pA1.path.at(-1)!.id;
  const pB1 = await api.createNode(storyId, { text: "B1: the first take that follows A1.", parentId: a1 });
  const b1 = pB1.path.at(-1)!.id;
  const pC1 = await api.createNode(storyId, { text: "C1: the part that follows B1.", parentId: b1 });
  const c1 = pC1.path.at(-1)!.id;
  const pB2 = await api.createNode(storyId, { text: "B2: a second take of the same part as B1.", parentId: a1 });
  const b2 = pB2.path.at(-1)!.id;
  const pC2 = await api.createNode(storyId, { text: "C2: the part that follows B2.", parentId: b2 });
  const c2 = pC2.path.at(-1)!.id;
  const pB3 = await api.createNode(storyId, { text: "B3: a third take, with nothing after it.", parentId: a1 });
  const b3 = pB3.path.at(-1)!.id;

  let breakId: string | null = null;
  if (options.chapterBreakTitle !== undefined) {
    const created2 = await api.createChapterBreak(storyId, b1, options.chapterBreakTitle);
    breakId = created2.breakId;
  }

  await api.switchLine(storyId, c1);
  return { storyId, a1, b1, c1, b2, c2, b3, breakId };
}

export async function collectPageDiagnostics(page: Page): Promise<PageDiagnostics> {
  const consoleErrors: string[] = [];
  const cspViolations: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => {
    consoleErrors.push(error.message);
  });
  await page.exposeFunction("__reportCspViolation", (detail: string) => {
    cspViolations.push(detail);
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      const reporter = (window as unknown as {
        __reportCspViolation?: (detail: string) => void;
      }).__reportCspViolation;
      reporter?.(`${event.violatedDirective}: ${event.blockedURI}`);
    });
  });
  return { consoleErrors, cspViolations };
}
