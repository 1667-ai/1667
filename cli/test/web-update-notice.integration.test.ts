import { afterEach, expect, test } from "bun:test";
import { startWebServer, type WebServer } from "../../host/web-server.js";
import type { BackgroundUpdateStarter } from "../../tui/src/index.js";
import { createWebUpdateNotice } from "../src/web-update-notice.js";

/**
 * `/api/status` and the background update check together: the real HTTP
 * server, the real notice service, and a real HTTP client reading the route
 * the web UI reads. The checker itself is the one injected dependency, so no
 * case here waits on a timer or reaches a registry — the real checker is
 * covered by `tui/test/update-runtime.test.ts` and by
 * `web-update-notice-e2e.test.ts`, which spawns `1667 web` itself.
 *
 * The check settles after the server is already answering, which is what
 * every case below turns on: a value the server captured at startup would
 * report `null` for the whole run.
 */

const servers: WebServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

interface Checker {
  readonly starter: BackgroundUpdateStarter;
  /** Publishes a notice the way a settled check does. */
  publish(message: string): void;
  stops(): number;
  starts(): number;
}

function checker(): Checker {
  let notify: ((message: string) => void) | null = null;
  let stops = 0;
  let starts = 0;
  return {
    starter: (onNotice) => {
      starts += 1;
      notify = onNotice;
      return () => { stops += 1; };
    },
    publish: (message) => notify?.(message),
    stops: () => stops,
    starts: () => starts
  };
}

interface StatusBody {
  readonly project: string;
  readonly version: string;
  readonly ownedLoopbackHttp: boolean;
  readonly update: { readonly pending: boolean; readonly notice: string | null };
}

async function serveWith(
  createStarter: () => BackgroundUpdateStarter | null
): Promise<{
  readonly origin: string;
  readonly status: () => Promise<StatusBody>;
  readonly unauthorizedStatus: () => Promise<Response>;
  readonly stopUpdateCheck: () => void;
}> {
  const updateNotice = createWebUpdateNotice({ createStarter });
  const server = await startWebServer({
    port: 0,
    assets: new Map(),
    projectLabel: "/scratch/project",
    version: "0.11.3",
    readingPositions: { load: async () => ({}), set: () => undefined },
    updateNotice
  });
  servers.push(server);
  const token = new URLSearchParams(new URL(server.url).hash.replace(/^#/, "")).get("token");
  expect(token).toMatch(/^[0-9a-f]{64}$/);
  // The check starts after the server is up, exactly as `web-command.ts`
  // orders it.
  const stopUpdateCheck = updateNotice.start();
  const origin = `http://127.0.0.1:${server.port}`;
  return {
    origin,
    stopUpdateCheck,
    status: async () => {
      const response = await fetch(`${origin}/api/status`, {
        headers: { authorization: `Bearer ${token!}` }
      });
      expect(response.status).toBe(200);
      return await response.json() as StatusBody;
    },
    unauthorizedStatus: async () => await fetch(`${origin}/api/status`)
  };
}

test("a notice the check publishes after startup reaches `/api/status`, "
  + "and the rest of the body is unchanged", async () => {
  const check = checker();
  const web = await serveWith(() => check.starter);

  expect(check.starts()).toBe(1);
  const before = await web.status();
  expect(before.update).toEqual({ pending: true, notice: null });
  // The fields the page already depended on stay exactly where they were.
  expect(before.project).toBe("/scratch/project");
  expect(before.version).toBe("0.11.3");
  expect(typeof before.ownedLoopbackHttp).toBe("boolean");

  check.publish("1667 0.12.0 available");
  const after = await web.status();
  expect(after.update).toEqual({ pending: false, notice: "1667 0.12.0 available" });
  // The message is the check's, word for word: the server neither rewords it
  // nor decides for itself whether to name an upgrade command.
  expect(after.update.notice).toContain("0.12.0");

  web.stopUpdateCheck();
  expect(check.stops()).toBe(1);
  // A notice that already arrived stays readable after shutdown; `pending`
  // does not, because nothing is checking any more.
  expect((await web.status()).update).toEqual({
    pending: false,
    notice: "1667 0.12.0 available"
  });
});

test("no checker for this run means nothing to wait for", async () => {
  // What `createBackgroundUpdateStarter` returns for `updates.mode: \"off\"`,
  // for `AI_1667_NO_UPDATE_CHECK=1`, and for a platform whose release target
  // is held from publication.
  const web = await serveWith(() => null);
  expect((await web.status()).update).toEqual({ pending: false, notice: null });
  web.stopUpdateCheck();
  expect((await web.status()).update).toEqual({ pending: false, notice: null });
});

test("a check that cannot be built or started leaves the page served and silent", async () => {
  const unbuildable = await serveWith(() => { throw new Error("unreadable config"); });
  expect((await unbuildable.status()).update).toEqual({ pending: false, notice: null });
  unbuildable.stopUpdateCheck();

  const unstartable = await serveWith(() => () => { throw new Error("no state root"); });
  expect((await unstartable.status()).update).toEqual({ pending: false, notice: null });
  unstartable.stopUpdateCheck();
});

test("a stop hook that throws does not keep `1667 web` from shutting down", async () => {
  const web = await serveWith(() => () => () => { throw new Error("stop fixture"); });
  expect((await web.status()).update.pending).toBeTrue();
  let threw = false;
  try {
    web.stopUpdateCheck();
  } catch {
    threw = true;
  }
  expect(threw).toBeFalse();
  expect((await web.status()).update).toEqual({ pending: false, notice: null });
});

test("an update notice is behind the same token gate as the rest of the status", async () => {
  const check = checker();
  const web = await serveWith(() => check.starter);
  check.publish("1667 0.12.0 available");
  expect((await web.status()).update.notice).toBe("1667 0.12.0 available");

  const refused = await web.unauthorizedStatus();
  expect(refused.status).toBe(401);
  expect(await refused.text()).not.toContain("0.12.0");
  web.stopUpdateCheck();
});
