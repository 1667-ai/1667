import { afterEach, expect, test } from "bun:test";
import { createServer } from "node:http";
import { connect } from "node:net";
import path from "node:path";
import {
  cleanupWebProcesses,
  scratchProject,
  spawnWeb,
  spawnWebRaw
} from "./web-e2e-fixture.js";

/**
 * `1667 web` is step 1 of the web UI (#409): open the project like the
 * embedded TUI does, hold the Worker host so the project lock stays taken,
 * and serve the shell page on loopback behind a per-run token. These tests
 * spawn the real CLI and drive it as an external client only — an HTTP
 * client, a raw socket, and OS signals — matching CLAUDE.md's preference for
 * an end-to-end test over one that pokes at internal structure. The spawn
 * helpers themselves live in `web-e2e-fixture.ts`, shared with
 * `web-bridge-e2e.test.ts`.
 */

/** The bridge origin joins `connect-src` explicitly — Safari does not treat
 * `'self'` as covering a same-origin `ws:` connection — so the CSP is now a
 * function of the run's own port. */
function csp(port: string): string {
  return "default-src 'none'; script-src 'self'; "
    + `connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port}; `
    + "style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
}

afterEach(cleanupWebProcesses);

test("the printed URL carries the token in the fragment, never the query string", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  expect(web.url).toContain("/#token=");
  expect(web.url).not.toContain("?token=");
  expect(web.token).toMatch(/^[0-9a-f]{64}$/);
}, 30_000);

test("AI_1667_DATA selects the project, and the default port is a fresh one", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--no-open"], { ...project.env, AI_1667_DATA: project.dataDir });
  expect(web.projectRoot.endsWith(`${path.sep}project`)).toBeTrue();
  expect(web.port).not.toBe("1667");
}, 30_000);

test("the shell page and the client script are public, and every security header is present", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);

  const page = await fetch(`${web.origin}/`);
  expect(page.status).toBe(200);
  const body = await page.text();
  // The shell carries no project data; only an authorized `/api/status`
  // fetch reveals it, so the initial HTML never leaks the project path.
  expect(body).not.toContain(web.projectRoot);
  expect(body).toContain("/app.js");
  assertSecurityHeaders(page, web.port);

  const script = await fetch(`${web.origin}/app.js`);
  expect(script.status).toBe(200);
  expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  const scriptBody = await script.text();
  expect(scriptBody).toContain("/api/status");
  expect(scriptBody).toContain("/api/bridge");
  expect(scriptBody).toContain("1667.web.token");
  assertSecurityHeaders(script, web.port);
}, 30_000);

test("/api/status answers with the project root and version once authorized with the bearer token", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);

  const status = await fetch(`${web.origin}/api/status`, {
    headers: { authorization: `Bearer ${web.token}` }
  });
  expect(status.status).toBe(200);
  const body = await status.json() as { project: string; version: string };
  expect(body.project).toBe(web.projectRoot);
  expect(typeof body.version).toBe("string");
  expect(body.version.length > 0).toBeTrue();
  assertSecurityHeaders(status, web.port);
}, 30_000);

test("missing or wrong bearer, wrong Host, and a foreign Origin are all refused", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);

  const noBearer = await fetch(`${web.origin}/api/status`);
  expect(noBearer.status).toBe(401);
  expect(await noBearer.text()).toContain("1667 web");

  const wrongBearer = await fetch(`${web.origin}/api/status`, {
    headers: { authorization: `Bearer ${"0".repeat(64)}` }
  });
  expect(wrongBearer.status).toBe(401);

  const wrongHostRoot = await fetch(`${web.origin}/`, { headers: { host: "evil.example:1" } });
  expect(wrongHostRoot.status).toBe(403);

  const wrongHostStatus = await fetch(`${web.origin}/api/status`, {
    headers: { host: "evil.example:1", authorization: `Bearer ${web.token}` }
  });
  expect(wrongHostStatus.status).toBe(403);

  const foreignOrigin = await fetch(`${web.origin}/api/status`, {
    headers: { authorization: `Bearer ${web.token}`, origin: "http://evil.example" }
  });
  expect(foreignOrigin.status).toBe(403);
}, 30_000);

test("a malformed request target answers 400 without taking the server down; "
  + "an unknown path is 404 and a disallowed method is 405", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);

  // `new URL("//bad:host", ...)` throws — "host" is not a valid port — and
  // Node's own HTTP parser is lenient enough to hand this request line to
  // the server instead of refusing it first.
  const raw = await rawRequest(
    Number(web.port),
    `GET //bad:host HTTP/1.1\r\nHost: 127.0.0.1:${web.port}\r\nConnection: close\r\n\r\n`
  );
  expect(raw).toContain(" 400 ");

  // The process is still serving afterward.
  const afterward = await fetch(`${web.origin}/`);
  expect(afterward.status).toBe(200);

  const posted = await fetch(`${web.origin}/`, { method: "POST" });
  expect(posted.status).toBe(405);

  const unknown = await fetch(`${web.origin}/does-not-exist`);
  expect(unknown.status).toBe(404);
}, 30_000);

test("a second `1667 web` on the same project fails with the existing project-lock message", async () => {
  const project = await scratchProject();
  await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);

  const second = spawnWebRaw(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const result = await second.exit;
  expect(result.code).not.toBe(0);
  expect(second.stderrText()).toContain("already open by");
}, 30_000);

test("SIGINT stops the server and releases the project lock for the next instance", async () => {
  const project = await scratchProject();
  const first = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);

  first.child.kill("SIGINT");
  const result = await first.exit;
  expect(result.code).toBe(0);
  expect(result.signal).toBe(null);

  // The lock is free again: a fresh instance on the same project starts.
  const second = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  expect(second.url).toContain("http://127.0.0.1:");
}, 30_000);

test("a port that is already taken fails, and the message suggests --port", async () => {
  const project = await scratchProject();
  const blocker = createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = blocker.address();
    if (address === null || typeof address === "string") {
      throw new Error("blocking server bound without a network address");
    }
    const attempt = spawnWebRaw(
      ["--data", project.dataDir, "--port", String(address.port), "--no-open"],
      project.env
    );
    const result = await attempt.exit;
    expect(result.code).not.toBe(0);
    expect(attempt.stderrText()).toContain("--port");
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }
}, 30_000);

function assertSecurityHeaders(response: Response, port: string): void {
  expect(response.headers.get("content-security-policy")).toBe(csp(port));
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-frame-options")).toBe("DENY");
}

/** Send a raw request line over a plain socket, bypassing `fetch`'s own URL
 * parsing, and return everything the server writes back before it closes
 * the connection. */
async function rawRequest(port: number, raw: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(Buffer.concat(chunks).toString("utf8"));
    }, 5_000);
    socket.once("connect", () => socket.write(raw));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("close", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

