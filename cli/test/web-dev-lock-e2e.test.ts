import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import {
  cleanupWebProcesses,
  killChild,
  scratchProject,
  spawnWeb,
  type WebChildProcess
} from "./web-e2e-fixture.js";

/**
 * Codex review (web/step-3-shell): `cli/scripts/web-dev.ts` spawns the real
 * `1667 web` backend (which takes the project lock immediately) before Vite
 * starts; if Vite then fails to start (`strictPort` finding 5173 already
 * taken, the scenario forced here), the script used to throw and exit
 * without ever killing that backend, leaving it running and the project
 * locked. Drives the real `web:dev` script and a real port conflict as
 * external clients — no internals poked at — then confirms the lock was
 * actually released by starting an ordinary `1667 web` against the same
 * project afterward.
 */

const webDevScript = fileURLToPath(new URL("../scripts/web-dev.ts", import.meta.url));

let devProcess: WebChildProcess | null = null;
let portHog: Server | null = null;

afterEach(async () => {
  if (devProcess !== null) await killChild(devProcess);
  devProcess = null;
  if (portHog !== null) await closePortHog(portHog);
  portHog = null;
  await cleanupWebProcesses();
});

function occupyPort5173(): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(5173, "127.0.0.1", () => resolve(server));
  });
}

/** Whatever probes port 5173 while it is deliberately occupied (Vite's own
 * `strictPort` check among them) can leave an idle connection this bare
 * `net.createServer()` never reads, writes, or ends on its own — the same
 * "`close()` never calls back" shape `host/web-server.ts`'s own `close()`
 * documents and works around, and for the same reason: `closeAllConnections()`
 * plus a timeout fallback, since nothing here has anything worth draining
 * gracefully for either. */
function closePortHog(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    server.close(settle);
    server.closeAllConnections();
    setTimeout(settle, 500);
  });
}

test("a Vite startup failure kills the backend it already spawned, releasing "
  + "the project lock", async () => {
  portHog = await occupyPort5173();
  const project = await scratchProject();
  devProcess = spawn(
    process.execPath,
    [webDevScript, "--data", project.dataDir, "--port", "0"],
    { env: project.env, stdio: ["ignore", "pipe", "pipe"] }
  ) as WebChildProcess;

  let stderr = "";
  devProcess.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    devProcess!.once("exit", (code, signal) => resolve({ code, signal }));
  });

  // Vite's own `strictPort` rejection should have surfaced as a failed
  // startup, not a hang or a clean exit.
  expect(exit.code).not.toBe(0);
  expect(stderr).not.toBe("");

  // The real assertion: the backend `web:dev` spawned is gone, and the
  // project lock it held is free. If the fix regressed and the backend
  // leaked, this second, ordinary `1667 web` would fail to start (or hang)
  // because the project is still locked.
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  expect(web.url).toContain("http://127.0.0.1:");
}, 30_000);
