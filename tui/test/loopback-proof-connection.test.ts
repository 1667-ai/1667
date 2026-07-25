import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createHttpServerProof,
  HTTP_SERVER_PROOF_HEADER,
  HTTP_SERVER_PROOF_PATH
} from "../../shared/http-server-proof.js";
import type { HttpAuthRecord } from "../../shared/http-auth.js";
import { createDirectLoopbackFetch } from "../src/direct-loopback-http.js";

/**
 * This suite exists because it runs under bun, where `node:http` exposes no
 * stable socket identity. The equivalent node coverage lives in
 * test/http-direct-loopback.test.ts and keeps the strict identity pinning; here
 * the point is that a correct server is reachable at all on this runtime, and
 * that a wrong HMAC is still refused.
 */
describe("loopback attach under bun", () => {
  test("a correct proof reaches the protected request", async () => {
    let protectedRequests = 0;
    const { origin, record, close } = await proofServer((path) => {
      if (path.startsWith("/api/")) protectedRequests += 1;
    });
    try {
      const response = await createDirectLoopbackFetch(origin, record)(
        `${origin}/api/private`,
        { method: "GET", headers: { authorization: "Bearer story" } }
      );
      expect(response.status).toBe(200);
      expect(protectedRequests).toBe(1);
    } finally {
      await close();
    }
  });

  test("a forged proof is refused before any protected request", async () => {
    let protectedRequests = 0;
    const { origin, record, close } = await proofServer(
      (path) => {
        if (path.startsWith("/api/")) protectedRequests += 1;
      },
      () => "f".repeat(64)
    );
    try {
      // The repo's bun-test shim has no `.rejects`, so settle it by hand.
      const failure = await createDirectLoopbackFetch(origin, record)(
        `${origin}/api/private`,
        { method: "GET" }
      ).then(() => null, (error: unknown) => error);
      expect(failure instanceof Error).toBeTrue();
      expect((failure as Error).message).toContain("exact-connection server proof");
      expect(protectedRequests).toBe(0);
    } finally {
      await close();
    }
  });
});

async function proofServer(
  onRequest: (path: string) => void,
  forgeProof?: () => string
): Promise<{
  origin: string;
  record: HttpAuthRecord;
  close: () => Promise<void>;
}> {
  let record: HttpAuthRecord | null = null;
  const server = createServer((request, response) => {
    const path = request.url ?? "/";
    onRequest(path);
    if (path.startsWith(HTTP_SERVER_PROOF_PATH)) {
      const nonce = new URL(path, "http://127.0.0.1").searchParams.get("nonce") ?? "";
      response.setHeader(
        HTTP_SERVER_PROOF_HEADER,
        forgeProof?.() ?? createHttpServerProof(record!, nonce)
      );
      response.writeHead(204);
      return void response.end();
    }
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
  });
  const origin = await new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
  record = {
    schema: 1,
    origin,
    instanceId: "11111111-1111-4111-8111-111111111111",
    capabilities: {
      story: "a".repeat(64),
      admin: "b".repeat(64)
    }
  };
  return {
    origin,
    record,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}
