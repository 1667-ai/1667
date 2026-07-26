import assert from "node:assert/strict";
import {
  lstat,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  bearerAuthorization,
  decodeHttpAuthRecord,
  decodeHttpInstanceMetadataResponse,
  HTTP_AUTHORIZATION_HEADER
} from "../shared/http-auth.js";
import { parseCanonicalLoopbackOrigin } from "../shared/http-loopback-origin.js";
import { httpCapabilityScopeForApiPath } from "../shared/http-capability-scope.js";
import {
  createHttpAuthRecord,
  readHttpAuthRecord,
  resolveHttpAuthRecordPaths
} from "../server/http-auth-record.js";
import { startHttpListener } from "../server/http-listener.js";
import {
  HTTP_API_PROTOCOL_VERSION,
  HTTP_CLIENT_PROTOCOL_HEADER
} from "../shared/http-protocol.js";
import { HttpOperationClient } from "../shared/http-operation-client.js";
import { httpRecoveryWarnings } from "../server/http-recovery-warnings.js";
import {
  internalErrorReference,
  toPublicServiceError
} from "../server/service-error-policy.js";
import { internalErrorLogPath } from "../server/internal-error-log.js";
import {
  privateTemporaryDirectory
} from "./http-listener-fixture.js";

test("canonical loopback origins reject DNS, aliases, and ambiguous literals", () => {
  for (const accepted of [
    "http://127.0.0.1:7373",
    "http://127.255.0.9:1",
    "http://[::1]:7373",
    "http://127.0.0.1:7373/"
  ]) {
    assert.equal(parseCanonicalLoopbackOrigin(accepted).origin, accepted.replace(/\/$/, ""));
  }
  for (const rejected of [
    "http://localhost:7373",
    "http://127.1:7373",
    "http://127.00.0.1:7373",
    "http://127.0.0.256:7373",
    "http://[::ffff:127.0.0.1]:7373",
    "http://[::1%25lo0]:7373",
    "http://user@127.0.0.1:7373",
    "http://127.0.0.1:7373/api",
    "https://127.0.0.1:7373"
  ]) {
    assert.throws(() => parseCanonicalLoopbackOrigin(rejected), /canonical numeric loopback/);
  }
});

test("HTTP capability scope policy is shared and rejects non-API paths", () => {
  assert.equal(httpCapabilityScopeForApiPath("/api/stories"), "story");
  assert.equal(httpCapabilityScopeForApiPath("/api/settings/check-server"), "admin");
  assert.throws(
    () => httpCapabilityScopeForApiPath("/api/future-route"),
    /no registered API head/
  );
  assert.throws(
    () => httpCapabilityScopeForApiPath("/settings"),
    /requires an API path/
  );
});

test("story recovery warnings never cross into admin authority", () => {
  const service = {
    archivedMutationWarnings: [{
      intent: {
        mutationId: "m1.1753356800000.22222222222222222222222222222222",
        method: "renameStory",
        input: { id: "st1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
      },
      resolution: {
        kind: "plain",
        code: "mutation_outcome_unknown",
        message: "Reload before retrying.",
        status: 409
      }
    }]
  };

  assert.deepEqual(httpRecoveryWarnings(service as never, "admin"), []);
  assert.deepEqual(httpRecoveryWarnings(service as never, null), []);
  assert.deepEqual(httpRecoveryWarnings(service as never, "story"), [{
    mutationId: "m1.1753356800000.22222222222222222222222222222222",
    method: "renameStory",
    storyId: "st1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    code: "mutation_outcome_unknown",
    message: "Reload before retrying.",
    status: 409
  }]);
});

test("HTTP instance discovery rejects an oversized body before JSON parsing", async () => {
  await assert.rejects(
    decodeHttpInstanceMetadataResponse(new Response("x".repeat(4_097))),
    /exceeds 4096 bytes/
  );
  assert.equal(
    (await decodeHttpInstanceMetadataResponse(Response.json({
      schema: 1,
      origin: "http://127.0.0.1:7373",
      instanceId: "11111111-1111-4111-8111-111111111111"
    }))).instanceId,
    "11111111-1111-4111-8111-111111111111"
  );
});

test("HTTP auth records are canonical, bounded, exact, and independently scoped", async (t) => {
  const stateRoot = await privateTemporaryDirectory(t, "1667-http-state-");
  const origin = "http://127.0.0.1:17373";
  const first = await createHttpAuthRecord(origin, { stateRoot });
  const info = await lstat(first.paths.final);
  assert.equal(info.mode & 0o777, 0o600);
  assert.notEqual(first.record.capabilities.story, first.record.capabilities.admin);
  assert.deepEqual((await readHttpAuthRecord(origin, { stateRoot })).record, first.record);

  const raw = await readFile(first.paths.final);
  assert.deepEqual(decodeHttpAuthRecord(raw), first.record);
  assert.throws(
    () => decodeHttpAuthRecord(Buffer.from(`${raw.toString("utf8")}\n`)),
    /canonical JSON/
  );
  assert.throws(
    () => decodeHttpAuthRecord(Buffer.from(
      raw.toString("utf8").replace('"schema":1', '"extra":0,"schema":1')
    )),
    /unknown or missing/
  );

  const second = await createHttpAuthRecord(origin, { stateRoot });
  assert.notEqual(second.record.instanceId, first.record.instanceId);
  await first.removeOwnRecord();
  assert.deepEqual((await readHttpAuthRecord(origin, { stateRoot })).record, second.record);
  await second.removeOwnRecord();
  await assert.rejects(readHttpAuthRecord(origin, { stateRoot }), /ENOENT/);
});

test("HTTP auth publication refuses a symlinked reserved temp", async (t) => {
  const stateRoot = await privateTemporaryDirectory(t, "1667-http-state-");
  const origin = "http://127.0.0.1:17374";
  const first = await createHttpAuthRecord(origin, { stateRoot });
  await symlink(first.paths.final, first.paths.next);
  await assert.rejects(
    createHttpAuthRecord(origin, { stateRoot }),
    /bounded regular file/
  );
  await first.removeOwnRecord();
});

test("HTTP auth publication rolls back a post-rename failure", async (t) => {
  const stateRoot = await privateTemporaryDirectory(t, "1667-http-state-");
  const origin = "http://127.0.0.1:17375";
  const paths = await resolveHttpAuthRecordPaths(origin, { stateRoot });
  await assert.rejects(
    createHttpAuthRecord(origin, {
      stateRoot,
      publicationHooks: {
        afterRename: () => {
          throw new Error("injected post-rename failure");
        }
      }
    }),
    /injected post-rename failure/
  );
  await assert.rejects(readFile(paths.final), /ENOENT/);
  const retry = await createHttpAuthRecord(origin, { stateRoot });
  await retry.removeOwnRecord();
});

test("listener publishes instance before data and guards scopes before routing", async (t) => {
  const stateRoot = await privateTemporaryDirectory(t, "1667-http-state-");
  const dataDir = path.join(await privateTemporaryDirectory(t, "1667-http-data-parent-"), "data");
  const listener = await startHttpListener({ port: 0, dataDir, authStore: { stateRoot } });
  t.after(() => listener.close());

  const instanceResponse = await fetch(`${listener.origin}/.well-known/1667-instance`);
  assert.deepEqual(await instanceResponse.json(), {
    schema: 1,
    origin: listener.origin,
    instanceId: listener.authRecord.instanceId
  });
  assert.equal((await fetch(`${listener.origin}/api/health`)).status, 200);
  assert.equal((await fetch(`${listener.origin}/`)).status, 404);

  const operations = new HttpOperationClient({
    root: listener.origin,
    authRecord: listener.authRecord,
    fetch
  });
  const storyHeaders = (await operations.reserve(
    "GET",
    "/api/stories",
    listener.authRecord.instanceId,
    undefined
  )).headers;
  const adminHeaders = (await operations.reserve(
    "GET",
    "/api/settings",
    listener.authRecord.instanceId,
    undefined
  )).headers;
  assert.equal((await fetch(`${listener.origin}/api/stories`, {
    headers: storyHeaders
  })).status, 200);
  assert.equal((await fetch(`${listener.origin}/api/settings`, {
    headers: storyHeaders
  })).status, 409);
  assert.equal((await fetch(`${listener.origin}/api//settings`, {
    headers: storyHeaders
  })).status, 400);
  assert.equal((await fetch(`${listener.origin}/api/stories`, {
    headers: adminHeaders
  })).status, 409);
  assert.equal((await fetch(`${listener.origin}/api/stories`, {
    headers: { [HTTP_CLIENT_PROTOCOL_HEADER]: String(HTTP_API_PROTOCOL_VERSION) }
  })).status, 401);
  assert.equal((await fetch(`${listener.origin}/api/future-route`, {
    headers: apiHeaders(listener, "story")
  })).status, 401);
  assert.equal((await fetch(`${listener.origin}/api/future-route`, {
    headers: apiHeaders(listener, "admin")
  })).status, 401);
  assert.equal((await fetch(`${listener.origin}/api/future-route`, {
    headers: { [HTTP_CLIENT_PROTOCOL_HEADER]: String(HTTP_API_PROTOCOL_VERSION) }
  })).status, 401);
  assert.equal((await fetch(`${listener.origin}/api/health/nested`)).status, 400);
  assert.equal((await fetch(`${listener.origin}/api/health/nested`, {
    headers: storyHeaders
  })).status, 404);

  const authPath = (await readHttpAuthRecord(listener.origin, { stateRoot })).paths.final;
  await listener.close();
  await assert.rejects(readFile(authPath), /ENOENT/);
});

test("listener tears down even when removing its auth record fails", async (t) => {
  const stateRoot = await privateTemporaryDirectory(t, "1667-http-state-");
  const dataDir = path.join(
    await privateTemporaryDirectory(t, "1667-http-data-parent-"),
    "data"
  );
  const listener = await startHttpListener({
    port: 0,
    dataDir,
    authStore: { stateRoot }
  });
  const authPath = (await readHttpAuthRecord(listener.origin, { stateRoot })).paths.final;
  await writeFile(authPath, "{", { mode: 0o600 });

  let reference: string | null = null;
  await assert.rejects(listener.close(), (error: unknown) => {
    assert.equal(toPublicServiceError(error).message, "Internal server error");
    reference = internalErrorReference(error);
    assert.match(reference ?? "", /^err_[0-9a-f]{24}$/);
    return true;
  });
  const diagnostic = await readFile(internalErrorLogPath(stateRoot), "utf8");
  assert.match(diagnostic, /JSON|auth record/i);
  assert.match(diagnostic, new RegExp(reference ?? ""));
  await assert.rejects(fetch(`${listener.origin}/api/health`));
});

test("development CORS is exact and production never emits wildcard credentials", async (t) => {
  const stateRoot = await privateTemporaryDirectory(t, "1667-http-state-");
  const dataDir = path.join(await privateTemporaryDirectory(t, "1667-http-data-parent-"), "data");
  const developmentOrigin = "http://127.0.0.1:5173";
  const listener = await startHttpListener({
    port: 0,
    dataDir,
    developmentOrigin,
    authStore: { stateRoot }
  });
  t.after(() => listener.close());

  const preflight = await fetch(`${listener.origin}/api/stories`, {
    method: "OPTIONS",
    headers: {
      origin: developmentOrigin,
      "access-control-request-method": "GET",
      "access-control-request-headers":
        `${HTTP_AUTHORIZATION_HEADER}, ${HTTP_CLIENT_PROTOCOL_HEADER}`
    }
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), developmentOrigin);
  assert.match(preflight.headers.get("vary") ?? "", /Origin/i);
  assert.equal(preflight.headers.get("access-control-allow-credentials"), null);

  const rejected = await fetch(`${listener.origin}/api/stories`, {
    method: "OPTIONS",
    headers: {
      origin: "http://127.0.0.1:5174",
      "access-control-request-method": "GET"
    }
  });
  assert.equal(rejected.status, 403);
  assert.equal(rejected.headers.get("access-control-allow-origin"), null);
});

function apiHeaders(
  listener: Awaited<ReturnType<typeof startHttpListener>>,
  scope: "story" | "admin"
): Record<string, string> {
  return {
    [HTTP_CLIENT_PROTOCOL_HEADER]: String(HTTP_API_PROTOCOL_VERSION),
    [HTTP_AUTHORIZATION_HEADER]:
      bearerAuthorization(listener.authRecord.capabilities[scope])
  };
}
