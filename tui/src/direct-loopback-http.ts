import { randomBytes } from "node:crypto";
import {
  Agent,
  request as httpRequest
} from "node:http";
import type { Socket } from "node:net";
import { Readable } from "node:stream";
import type { HttpAuthRecord } from "../../shared/http-auth.js";
import { parseCanonicalLoopbackOrigin } from "../../shared/http-loopback-origin.js";
import {
  HTTP_SERVER_PROOF_HEADER,
  HTTP_SERVER_PROOF_NONCE_BYTES,
  HTTP_SERVER_PROOF_PATH,
  matchesHttpServerProof
} from "../../shared/http-server-proof.js";

export type HttpFetch = (
  input: string | URL,
  init?: RequestInit
) => Promise<Response>;

/** One cryptographically proven HTTP/1.1 connection per request. */
export function createDirectLoopbackFetch(
  originInput: string,
  authRecord: HttpAuthRecord
): HttpFetch {
  const target = parseCanonicalLoopbackOrigin(originInput);
  if (authRecord.origin !== target.origin) {
    throw new Error("1667 HTTP proof record does not match the loopback origin");
  }
  const expectedPeer = target.hostname === "[::1]" ? "::1" : target.hostname;
  const dialHost = expectedPeer;
  return async (input, init = {}) => {
    const endpoint = new URL(String(input), target.origin);
    if (endpoint.origin !== target.origin) {
      throw new Error("1667 HTTP transport refuses cross-origin requests");
    }
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    headers.set("connection", "close");
    const body = requestBody(init.body);
    const signal = init.signal ?? undefined;
    if (signal?.aborted === true) throw abortError();
    const agent = new Agent({
      keepAlive: true,
      maxSockets: 1,
      maxFreeSockets: 1
    });
    try {
      const provenSocket = await proveConnection(
        agent,
        dialHost,
        target.port,
        expectedPeer,
        authRecord,
        signal
      );
      return await sendOnProvenConnection(
        agent,
        provenSocket,
        dialHost,
        target.port,
        expectedPeer,
        method,
        `${endpoint.pathname}${endpoint.search}`,
        headers,
        body,
        signal
      );
    } catch (error) {
      agent.destroy();
      throw error;
    }
  };
}

async function proveConnection(
  agent: Agent,
  hostname: string,
  port: number,
  expectedPeer: string,
  authRecord: HttpAuthRecord,
  signal: AbortSignal | undefined
): Promise<Socket> {
  const nonce = randomBytes(HTTP_SERVER_PROOF_NONCE_BYTES).toString("hex");
  return await new Promise<Socket>((resolve, reject) => {
    let settled = false;
    let proofSocket: Socket | null = null;
    const client = httpRequest({
      hostname,
      port,
      method: "HEAD",
      path: `${HTTP_SERVER_PROOF_PATH}?nonce=${nonce}`,
      headers: { connection: "keep-alive" },
      agent
    });
    const finishReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onAbort = () => {
      const error = abortError();
      client.destroy(error);
      finishReject(error);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    client.once("error", finishReject);
    client.once("socket", (socket) => {
      proofSocket = socket;
    });
    client.once("response", (incoming) => {
      const proof = incoming.headers[HTTP_SERVER_PROOF_HEADER];
      const responseUsedProofSocket =
        proofSocket !== null && sameProvenConnection(incoming.socket, proofSocket);
      incoming.resume();
      incoming.once("end", () => {
        const socket = proofSocket;
        if (incoming.statusCode !== 204
          || socket === null
          || !responseUsedProofSocket
          || socket.destroyed
          || !peerMatches(socket, expectedPeer)
          || !matchesHttpServerProof(authRecord, nonce, proof)) {
          finishReject(new Error(
            "1667 HTTP listener failed exact-connection server proof"
          ));
          return;
        }
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        resolve(socket);
      });
    });
    client.end();
  });
}

async function sendOnProvenConnection(
  agent: Agent,
  provenSocket: Socket,
  hostname: string,
  port: number,
  expectedPeer: string,
  method: string,
  path: string,
  headers: Headers,
  body: string | Uint8Array | undefined,
  signal: AbortSignal | undefined
): Promise<Response> {
  return await new Promise<Response>((resolve, reject) => {
    let settled = false;
    const client = httpRequest({
      hostname,
      port,
      method,
      path,
      agent
    });
    const finishReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onAbort = () => {
      const error = abortError();
      client.destroy(error);
      finishReject(error);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    client.once("error", finishReject);
    client.once("socket", (socket) => {
      void verifyThenSend(
        socket,
        provenSocket,
        expectedPeer,
        client,
        headers,
        body
      ).catch((error) => {
        client.destroy();
        finishReject(error);
      });
    });
    client.once("response", (incoming) => {
      if (settled) return void incoming.destroy();
      settled = true;
      incoming.once("close", () => {
        signal?.removeEventListener("abort", onAbort);
        agent.destroy();
      });
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) {
          for (const entry of value) responseHeaders.append(name, entry);
        } else if (value !== undefined) responseHeaders.set(name, value);
      }
      const status = incoming.statusCode ?? 500;
      const noBody = method === "HEAD" || status === 204 || status === 304;
      if (noBody) incoming.resume();
      resolve(new Response(
        noBody ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>,
        {
          status,
          statusText: incoming.statusMessage,
          headers: responseHeaders
        }
      ));
    });
  });
}

async function verifyThenSend(
  socket: Socket,
  provenSocket: Socket,
  expectedPeer: string,
  client: ReturnType<typeof httpRequest>,
  headers: Headers,
  body: string | Uint8Array | undefined
): Promise<void> {
  if (socket.connecting) {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
  }
  if (!sameProvenConnection(socket, provenSocket)
    || socket.destroyed
    || !peerMatches(socket, expectedPeer)) {
    throw new Error(
      "1667 HTTP transport refused an unproven loopback connection"
    );
  }
  headers.forEach((value, name) => client.setHeader(name, value));
  client.end(body);
}

/**
 * Whether a socket is the connection the server already proved itself on.
 *
 * Node's `node:http` hands out one stable socket object per keep-alive
 * connection, so identity is exact and is enforced. Bun's compatibility layer
 * does not: it exposes a different object on the response than on the request,
 * returns a fresh object for the next request on the same agent, and ignores a
 * custom `createConnection`, so there is nothing stable to compare. On that
 * runtime the exact-connection HMAC over origin, instance ID and nonce remains
 * authoritative — the same trade this file already documents for the missing
 * `remoteAddress`. Every request still dials the one canonical loopback origin
 * and still verifies that HMAC before any payload is sent.
 */
function sameProvenConnection(
  candidate: Socket | null | undefined,
  proven: Socket
): boolean {
  if (candidate === proven) return true;
  return process.versions.bun !== undefined;
}

function peerMatches(socket: Socket, expectedPeer: string): boolean {
  const remote = socket.remoteAddress;
  return remote === expectedPeer
    || (expectedPeer.startsWith("127.") && remote === `::ffff:${expectedPeer}`)
    // Bun omits remoteAddress on its node:http compatibility socket. Exact
    // connection HMAC proof remains authoritative on that runtime.
    || (remote === undefined && process.versions.bun !== undefined);
}

function requestBody(body: BodyInit | null | undefined): string | Uint8Array | undefined {
  if (body === null || body === undefined) return undefined;
  if (typeof body === "string" || body instanceof Uint8Array) return body;
  throw new Error("1667 HTTP transport accepts only string or byte request bodies");
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}
