import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadReadingPositions,
  readingPositionStoreFile
} from "../../host/reading-position-store.js";
import { projectDirectory } from "../../server/project-layout.js";
import { openWebBridgeTransport, webBridgeProtocols, webBridgeUrl } from "../../client/web-bridge-transport.js";
import { storyApiFromWorkerTransport } from "../../client/worker-story-api.js";
import {
  BunWebSocket,
  cleanupWebProcesses,
  scratchProject,
  spawnWeb,
  type ReadyWeb,
  type ScratchProject
} from "./web-e2e-fixture.js";

/**
 * `1667 web`'s durable reading positions (#409 step 4): the store the
 * embedded TUI already keeps under `~/.config/1667/reading-positions/` is
 * also served over HTTP here, so the web UI and the TUI agree on where a
 * reader left off. These tests spawn the real CLI and drive it as an
 * external HTTP client (`web-e2e-fixture.ts`), matching CLAUDE.md's
 * preference for an end-to-end test over one that pokes at internal
 * structure; the one exception is the "TUI reads what the web wrote" case,
 * which reads the store file back through the same host store API the TUI
 * itself calls, because there is no TUI process to spawn here.
 *
 * Every test gets its own `XDG_CONFIG_HOME` (a temp dir, restored after),
 * so no test ever reads or writes the real `~/.config`.
 */

interface ConfigHome {
  readonly dir: string;
  dispose(): Promise<void>;
}

async function scratchConfigHome(): Promise<ConfigHome> {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-reading-positions-config-"));
  const prior = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
  return {
    dir,
    dispose: async () => {
      if (prior === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prior;
      await rm(dir, { recursive: true, force: true });
    }
  };
}

afterEach(async () => {
  await cleanupWebProcesses();
});

async function createStoryId(web: ReadyWeb): Promise<string> {
  const socket = new BunWebSocket(webBridgeUrl({ host: `127.0.0.1:${web.port}` }), {
    protocols: webBridgeProtocols(web.token),
    headers: { origin: web.origin }
  });
  const { transport } = await openWebBridgeTransport(socket);
  try {
    const api = storyApiFromWorkerTransport(transport);
    const created = await api.createStory();
    return created.id;
  } finally {
    transport.close();
  }
}

async function spawnScratchWeb(project: ScratchProject, configHome: ConfigHome): Promise<ReadyWeb> {
  return await spawnWeb(
    ["--data", project.dataDir, "--port", "0", "--no-open"],
    { ...project.env, XDG_CONFIG_HOME: configHome.dir }
  );
}

/** `scratchProject()`'s `dataDir` sits under `os.tmpdir()`, which on macOS is
 * itself a symlink (`/var` -> `/private/var`); the project resolver realpaths
 * a project directory once it exists (`server/project-discovery.ts`), so a
 * store-file lookup computed from the unresolved path would hash to a
 * different file than the one the running `1667 web` actually wrote to.
 * Canonicalizing the scratch root up front keeps both sides identical. */
async function canonicalScratchProject(): Promise<ScratchProject> {
  const project = await scratchProject();
  const canonicalRoot = await realpath(path.dirname(project.dataDir));
  return { ...project, dataDir: path.join(canonicalRoot, path.basename(project.dataDir)) };
}

/** The project's actual data directory (`<root>/.1667`), matching exactly
 * what `cli/src/embedded-project.ts`'s `openProject` resolves and hands to
 * `readingPositionStoreFile` — see `canonicalScratchProject`. */
function projectDataDirectory(project: ScratchProject): string {
  return projectDirectory(project.dataDir);
}

/** A focus change's store write is debounced (~400ms; `PERSIST_DEBOUNCE_MS`
 * in `host/reading-position-store.ts`), so a GET issued immediately after a
 * PUT can still read the pre-write file. Poll instead of a fixed sleep. */
async function waitForPositions(
  web: ReadyWeb,
  expected: Readonly<Record<string, string>>
): Promise<void> {
  const auth = { authorization: `Bearer ${web.token}` };
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await fetch(`${web.origin}/api/reading-positions`, { headers: auth });
    const body = await response.json() as { positions: Record<string, string> };
    if (JSON.stringify(body.positions) === JSON.stringify(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const response = await fetch(`${web.origin}/api/reading-positions`, { headers: auth });
  expect(await response.json()).toEqual({ positions: expected });
}

test("GET without a bearer is refused; with it, an empty project answers no positions", async () => {
  const project = await scratchProject();
  const configHome = await scratchConfigHome();
  try {
    const web = await spawnScratchWeb(project, configHome);

    const noBearer = await fetch(`${web.origin}/api/reading-positions`);
    expect(noBearer.status).toBe(401);

    const ok = await fetch(`${web.origin}/api/reading-positions`, {
      headers: { authorization: `Bearer ${web.token}` }
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ positions: {} });
  } finally {
    await configHome.dispose();
  }
}, 30_000);

test("PUT sets a position; GET reflects it; PUT without a bearer is refused", async () => {
  const project = await scratchProject();
  const configHome = await scratchConfigHome();
  try {
    const web = await spawnScratchWeb(project, configHome);
    const storyId = await createStoryId(web);

    const noBearer = await fetch(`${web.origin}/api/reading-positions/${storyId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ partId: "part-1" })
    });
    expect(noBearer.status).toBe(401);

    const put = await fetch(`${web.origin}/api/reading-positions/${storyId}`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${web.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ partId: "part-1" })
    });
    expect(put.status).toBe(204);
    await waitForPositions(web, { [storyId]: "part-1" });

    // null deletes.
    const cleared = await fetch(`${web.origin}/api/reading-positions/${storyId}`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${web.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ partId: null })
    });
    expect(cleared.status).toBe(204);
    await waitForPositions(web, {});
  } finally {
    await configHome.dispose();
  }
}, 30_000);

test("a bad story id, a non-JSON content type, and a malformed body are all refused", async () => {
  const project = await scratchProject();
  const configHome = await scratchConfigHome();
  try {
    const web = await spawnScratchWeb(project, configHome);
    const storyId = await createStoryId(web);
    const auth = { authorization: `Bearer ${web.token}` };

    const badId = await fetch(`${web.origin}/api/reading-positions/not_a_valid_id!`, {
      method: "PUT",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ partId: "part-1" })
    });
    expect(badId.status).toBe(400);

    const wrongContentType = await fetch(`${web.origin}/api/reading-positions/${storyId}`, {
      method: "PUT",
      headers: { ...auth, "content-type": "text/plain" },
      body: JSON.stringify({ partId: "part-1" })
    });
    expect(wrongContentType.status).toBe(415);

    const notJson = await fetch(`${web.origin}/api/reading-positions/${storyId}`, {
      method: "PUT",
      headers: { ...auth, "content-type": "application/json" },
      body: "not json"
    });
    expect(notJson.status).toBe(400);

    const missingField = await fetch(`${web.origin}/api/reading-positions/${storyId}`, {
      method: "PUT",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({})
    });
    expect(missingField.status).toBe(400);

    const wrongType = await fetch(`${web.origin}/api/reading-positions/${storyId}`, {
      method: "PUT",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ partId: 42 })
    });
    expect(wrongType.status).toBe(400);

    const oversizedBody = await fetch(`${web.origin}/api/reading-positions/${storyId}`, {
      method: "PUT",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ partId: "x".repeat(2_000), padding: "y".repeat(2_000) })
    });
    expect(oversizedBody.status).toBe(413);

    // Confirm none of the refused writes landed.
    const positions = await fetch(`${web.origin}/api/reading-positions`, { headers: auth });
    expect(await positions.json()).toEqual({ positions: {} });
  } finally {
    await configHome.dispose();
  }
}, 30_000);

test("a position survives a 1667 web restart on the same project", async () => {
  const project = await canonicalScratchProject();
  const configHome = await scratchConfigHome();
  try {
    const first = await spawnScratchWeb(project, configHome);
    const storyId = await createStoryId(first);
    const put = await fetch(`${first.origin}/api/reading-positions/${storyId}`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${first.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ partId: "part-7" })
    });
    expect(put.status).toBe(204);
    // SIGINT (not SIGTERM): `runWebCommand` listens for both, but SIGINT is
    // the signal `cli/test/web-command-e2e.test.ts`'s own shutdown test uses
    // and is proven to exit cleanly (code 0) here.
    first.child.kill("SIGINT");
    const exited = await first.exit;
    expect(exited.code).toBe(0);

    const second = await spawnScratchWeb(project, configHome);
    const after = await fetch(`${second.origin}/api/reading-positions`, {
      headers: { authorization: `Bearer ${second.token}` }
    });
    expect(await after.json()).toEqual({ positions: { [storyId]: "part-7" } });
  } finally {
    await configHome.dispose();
  }
}, 30_000);

test("a position the web writes is exactly what the TUI's own store API reads", async () => {
  const project = await canonicalScratchProject();
  const configHome = await scratchConfigHome();
  try {
    const web = await spawnScratchWeb(project, configHome);
    const storyId = await createStoryId(web);
    const put = await fetch(`${web.origin}/api/reading-positions/${storyId}`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${web.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ partId: "part-3" })
    });
    expect(put.status).toBe(204);
    web.child.kill("SIGINT");
    const exited = await web.exit;
    expect(exited.code).toBe(0);

    // The exact scope the embedded TUI resolves for this same project
    // (`readingPositionStoreFile(dataDir, null)`, `origin: null`) — proves
    // the web wrote to the file the TUI reads, not a lookalike of its own.
    const storeFile = readingPositionStoreFile(projectDataDirectory(project), null);
    expect(loadReadingPositions({ file: storeFile })).toEqual({ [storyId]: "part-3" });
  } finally {
    await configHome.dispose();
  }
}, 30_000);
