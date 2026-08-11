import assert from "node:assert/strict";
import {
  createServer,
  type Server
} from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import type { HttpAuthRecord } from "../shared/http-auth.js";
import {
  createHttpServerProof,
  HTTP_SERVER_PROOF_HEADER,
  HTTP_SERVER_PROOF_PATH
} from "../shared/http-server-proof.js";
import { createDirectLoopbackFetch } from "../tui/src/direct-loopback-http.js";

test("direct loopback transport proves the exact connection before secrets", async (t) => {
  let record!: HttpAuthRecord;
  let connections = 0;
  let protectedRequests = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", record.origin);
    if (url.pathname === HTTP_SERVER_PROOF_PATH) {
      assert.equal(request.headers.authorization, undefined);
      const nonce = url.searchParams.get("nonce")!;
      response.writeHead(204, {
        [HTTP_SERVER_PROOF_HEADER]: createHttpServerProof(record, nonce)
      });
      response.end();
      return;
    }
    protectedRequests += 1;
    assert.equal(request.headers.authorization, "Bearer private-capability");
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      assert.equal(body, "private-body");
      response.end("ok");
    });
  });
  server.on("connection", () => { connections += 1; });
  const origin = await listen(t, server);
  record = authRecord(origin);

  const response = await createDirectLoopbackFetch(origin, record)(
    `${origin}/api/private`,
    {
      method: "POST",
      headers: { authorization: "Bearer private-capability" },
      body: "private-body"
    }
  );

  assert.equal(await response.text(), "ok");
  assert.equal(protectedRequests, 1);
  assert.equal(connections, 1);
});

test("direct loopback transport sends no secrets to an unproven listener", async (t) => {
  let protectedRequests = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === HTTP_SERVER_PROOF_PATH) {
      assert.equal(request.headers.authorization, undefined);
      response.writeHead(204, {
        [HTTP_SERVER_PROOF_HEADER]: "00".repeat(32)
      });
      response.end();
      return;
    }
    protectedRequests += 1;
    response.end();
  });
  const origin = await listen(t, server);

  await assert.rejects(
    createDirectLoopbackFetch(origin, authRecord(origin))(
      `${origin}/api/private`,
      {
        method: "POST",
        headers: { authorization: "Bearer private-capability" },
        body: "private-body"
      }
    ),
    /exact-connection server proof/
  );
  assert.equal(protectedRequests, 0);
});

// D10: `tui/src/api.ts`'s binary request path used to send `body.slice().buffer`,
// an `ArrayBuffer`. `createDirectLoopbackFetch`'s body guard accepts only a
// string or a `Uint8Array` (see `requestBody` below), so a binary upload in
// `--url` mode (importLorebook, importCard, and now Draft Image staging)
// threw before it ever reached the network. Global `fetch` accepts an
// `ArrayBuffer` too, which is why the existing tests in this repository,
// bound to global `fetch`, never caught it. This test drives the direct
// loopback transport itself and would have failed against the old
// `.buffer` code with "accepts only string or byte request bodies".
test("direct loopback transport sends a Uint8Array body byte-for-byte", async (t) => {
  let record!: HttpAuthRecord;
  let received: Buffer | null = null;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", record.origin);
    if (url.pathname === HTTP_SERVER_PROOF_PATH) {
      const nonce = url.searchParams.get("nonce")!;
      response.writeHead(204, {
        [HTTP_SERVER_PROOF_HEADER]: createHttpServerProof(record, nonce)
      });
      response.end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received = Buffer.concat(chunks);
      response.end("ok");
    });
  });
  const origin = await listen(t, server);
  record = authRecord(origin);

  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 255, 0]);
  const response = await createDirectLoopbackFetch(origin, record)(
    `${origin}/api/private`,
    {
      method: "POST",
      headers: { authorization: "Bearer private-capability" },
      body: bytes
    }
  );

  assert.equal(await response.text(), "ok");
  assert.ok(received !== null);
  assert.ok(Buffer.from(bytes).equals(received!), "the server must receive the exact bytes sent");
});

// The old code sent `body.slice().buffer as ArrayBuffer`. This proves that
// exact shape is rejected — the regression the fix above closes.
test("direct loopback transport rejects an ArrayBuffer body", async (t) => {
  const server = createServer((_request, response) => response.end());
  const origin = await listen(t, server);
  const record = authRecord(origin);

  const arrayBuffer = new Uint8Array([1, 2, 3]).slice().buffer;
  await assert.rejects(
    createDirectLoopbackFetch(origin, record)(
      `${origin}/api/private`,
      { method: "POST", body: arrayBuffer as unknown as BodyInit }
    ),
    /accepts only string or byte request bodies/
  );
});

function authRecord(origin: string): HttpAuthRecord {
  return {
    schema: 1,
    origin,
    instanceId: "11111111-1111-4111-8111-111111111111",
    capabilities: {
      story: "11".repeat(32),
      admin: "22".repeat(32)
    }
  };
}

async function listen(t: TestContext, server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  }));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}
