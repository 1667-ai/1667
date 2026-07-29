import { createServer, type Server } from "node:http";
import type { TestContext } from "node:test";
import type { HttpAuthRecord } from "../shared/http-auth.js";
import {
  createHttpServerProof,
  HTTP_SERVER_PROOF_HEADER,
  HTTP_SERVER_PROOF_PATH
} from "../shared/http-server-proof.js";
import { createHttpAuthRecord } from "../server/http-auth-record.js";

export async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

export async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

export async function startProvenReplacementServer(
  t: TestContext,
  origin: string,
  port: number,
  stateRoot: string,
  health: (candidate: HttpAuthRecord) => unknown
): Promise<void> {
  let candidateRecord: HttpAuthRecord | undefined;
  const server = createServer((request, response) => {
    const candidate = candidateRecord;
    if (candidate === undefined) {
      response.statusCode = 503;
      response.end();
      return;
    }
    const url = new URL(request.url ?? "/", origin);
    if (url.pathname === HTTP_SERVER_PROOF_PATH
      && request.method === "HEAD") {
      response.setHeader(
        HTTP_SERVER_PROOF_HEADER,
        createHttpServerProof(
          candidate,
          url.searchParams.get("nonce") ?? ""
        )
      );
      response.statusCode = 204;
      response.end();
      return;
    }
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/.well-known/1667-instance") {
      response.end(JSON.stringify({
        schema: 1,
        origin,
        instanceId: candidate.instanceId
      }));
      return;
    }
    if (url.pathname === "/api/health") {
      response.end(JSON.stringify(health(candidate)));
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });
  t.after(() => closeServer(server));
  await listen(server, port);
  const candidate = await createHttpAuthRecord(origin, { stateRoot });
  candidateRecord = candidate.record;
  t.after(() => candidate.removeOwnRecord());
}
