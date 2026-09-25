import { spawn } from "node:child_process";
import { Socket } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { errorMessage, openInBrowser } from "../src/open-browser.js";
import { READY_LINE, STANDALONE_ENTRY } from "../test/web-e2e-fixture.js";

/** Bun 1.3.14's `node:net` has no `Socket.prototype.destroySoon` (verified
 * against that version): Vite's bundled `http-proxy` calls it while tearing
 * down the `/api` proxy's sockets, which otherwise crashes this whole dev
 * script on shutdown (and on the proxy's own connection churn) with
 * "socket.destroySoon is not a function". Node's real `destroySoon` flushes
 * pending writes before destroying, which is exactly `end()` followed by the
 * `close` event's own cleanup — `end()` alone is the closest equivalent Bun
 * actually implements. */
const socketPrototype = Socket.prototype as unknown as { destroySoon?: () => void };
if (typeof socketPrototype.destroySoon !== "function") {
  socketPrototype.destroySoon = function destroySoon(this: Socket): void {
    this.end();
  };
}

/**
 * `bun run web:dev`: run the real `1667 web` backend (so every request still
 * goes through its token, its Worker host, and its real project), fronted by
 * Vite's own dev server for the page — fast refresh, no rebuild-on-every-request.
 * `web/vite.config.ts`'s `/api` proxy forwards to the backend this spawns,
 * rewriting `Origin` to match it (see that file for why); this script only
 * has to find the backend's port and token, and hand Vite's dev origin to it
 * as `AI_1667_WEB_DEV_TARGET`.
 */

const cliRoot = fileURLToPath(new URL("..", import.meta.url));
const viteConfigFile = path.join(cliRoot, "..", "web", "vite.config.ts");
const DEV_URL_BASE = "http://127.0.0.1:5173";

async function main(): Promise<void> {
  const extraArgs = process.argv.slice(2);
  const backend = spawn(
    process.execPath,
    [STANDALONE_ENTRY, "web", "--no-open", "--port", "0", ...extraArgs],
    { stdio: ["ignore", "pipe", "inherit"] }
  );

  const backendUrl = await waitForReadyUrl(backend);
  const parsedBackendUrl = new URL(backendUrl);
  const token = new URLSearchParams(parsedBackendUrl.hash.replace(/^#/, "")).get("token");
  if (token === null) {
    throw new Error(`1667 web printed a URL with no token fragment: ${backendUrl}`);
  }

  // `configure` in `web/vite.config.ts` reads `process.env.AI_1667_WEB_DEV_TARGET`
  // directly (it runs as plain Node code, not through Vite's own env
  // pipeline), so this has to be a real process environment variable, set
  // before `createServer` loads that config file.
  process.env.AI_1667_WEB_DEV_TARGET = parsedBackendUrl.origin;
  const vite = await createServer({ configFile: viteConfigFile });
  await vite.listen();

  const devUrl = `${DEV_URL_BASE}/#token=${token}`;
  process.stdout.write(`1667 web dev: ${devUrl}\n`);
  process.stdout.write("Press Ctrl+C to stop.\n");
  try {
    await openInBrowser(devUrl);
  } catch (error) {
    process.stderr.write(
      `1667 web dev: could not open a browser automatically (${errorMessage(error)}). `
        + "Open the address above yourself.\n"
    );
  }

  const shutdown = (): void => {
    void vite.close().finally(() => backend.kill("SIGINT"));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  backend.once("exit", (code) => {
    void vite.close().finally(() => process.exit(code ?? 0));
  });
}

function waitForReadyUrl(child: ReturnType<typeof spawn>): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let buffered = "";
    const onData = (chunk: Buffer): void => {
      buffered += chunk.toString("utf8");
      const match = READY_LINE.exec(buffered);
      if (match === null) return;
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
      resolve(match[2]!);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      reject(new Error(`1667 web exited before it printed its URL (code ${code}, signal ${signal})`));
    };
    child.stdout?.on("data", onData);
    child.once("exit", onExit);
  });
}

await main();
