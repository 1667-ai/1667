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
import type { ReadyWeb } from "../test/web-e2e-fixture.js";

/**
 * `playwright-core` driving the system Chrome (owner decision), shared by
 * every `cli/test-web-ui/*.test.ts` file. Role/name locators only — never a
 * CSS class selector, which is an implementation detail the design is free
 * to rename.
 */

/** Bun's `WebSocket` accepts `{ protocols, headers }` as its second
 * constructor argument (verified against Bun 1.3.14, same as
 * `cli/test/web-bridge-e2e.test.ts`); the DOM lib type only declares
 * `string | string[]`. */
type BunWebSocketConstructor = new (
  url: string,
  init?: {
    readonly protocols?: readonly string[];
    readonly headers?: Readonly<Record<string, string>>;
  }
) => WebSocket;
const BunWebSocket = WebSocket as unknown as BunWebSocketConstructor;

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
