import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import { listenLoopback } from "../server/loopback-listen.js";
import {
  WEB_BRIDGE_SUBPROTOCOL,
  WEB_BRIDGE_TOKEN_PREFIX
} from "../shared/web-bridge-protocol.js";
import { WEB_APP_JS, WEB_SHELL_HTML } from "./web-placeholder.js";

/** 32 random bytes, hex-encoded: matches the story-scope capability length,
 * so a candidate of the wrong shape never reaches `timingSafeEqual` with
 * mismatched buffer lengths. */
export const WEB_TOKEN_BYTES = 32;
const TOKEN_HEX_PATTERN = /^[0-9a-f]{64}$/;
const INVALID_TOKEN = Buffer.alloc(WEB_TOKEN_BYTES);
const BEARER_PREFIX = "Bearer ";

/** Mint one per-run token. The caller (`cli/src/web-command.ts`) shares it
 * with `host/web-bridge-server.ts`, so an HTTP request and a WebSocket
 * upgrade on the same run accept exactly the same credential. */
export function generateWebToken(): string {
  return randomBytes(WEB_TOKEN_BYTES).toString("hex");
}

/** A CSP is loopback-only and depends on the run's own port: Safari does not
 * treat `'self'` as covering a same-origin `ws:` connection, so the bridge
 * origin is named explicitly, in both host forms `loopbackHostForms` accepts. */
function securityHeaders(port: number): Record<string, string> {
  return {
    "content-security-policy": "default-src 'none'; script-src 'self'; "
      + `connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port}; `
      + "style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
    "x-frame-options": "DENY"
  };
}

export interface WebServerOptions {
  readonly port: number;
  /** Shared with `host/web-bridge-server.ts` — see `generateWebToken`. */
  readonly token: string;
  /** The project root, shown on the placeholder page. */
  readonly projectLabel: string;
  /** The running build's version, shown on the placeholder page. */
  readonly version: string;
}

export interface WebServer {
  readonly url: string;
  readonly port: number;
  /** The raw listener, so `host/web-bridge-server.ts` can attach its own
   * `upgrade` handler to the exact same loopback socket rather than binding
   * a second port. */
  readonly httpServer: Server;
  close(): Promise<void>;
}

/**
 * A small loopback HTTP server for `1667 web`. Every route is guarded by a
 * per-run token minted by the caller and handed to the browser only in the
 * URL fragment — unlike a cookie, a fragment is never sent to another
 * loopback port, so a malicious local service on a different port cannot
 * replay it. It does not touch the story backend; the caller holds that
 * separately.
 */
export async function startWebServer(options: WebServerOptions): Promise<WebServer> {
  const server = createServer();
  await listenLoopback(server, options.port);
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("1667 web server bound without a loopback network address");
  }
  const context: RequestContext = {
    port: address.port,
    tokenBuffer: Buffer.from(options.token, "hex"),
    projectLabel: options.projectLabel,
    version: options.version
  };
  server.on("request", (request, response) => {
    handleRequest(request, response, context);
  });
  return {
    url: `http://127.0.0.1:${address.port}/#token=${options.token}`,
    port: address.port,
    httpServer: server,
    close: () => new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: NodeJS.ErrnoException): void => {
        if (settled) return;
        settled = true;
        clearTimeout(fallback);
        if (error === undefined || isAlreadyClosed(error)) resolve();
        else reject(error);
      };
      server.close(settle);
      // Idle keep-alive sockets otherwise hold `close()` open indefinitely;
      // the shell page has nothing worth draining gracefully for.
      server.closeAllConnections();
      // Once any connection has been `upgrade`d, Bun's `node:http` server
      // never invokes `close`'s callback at all — verified against Bun
      // 1.3.14, even after `closeAllConnections()` and after the upgraded
      // socket is independently confirmed fully destroyed
      // (`host/web-bridge-server.ts`'s own `WsBridgeSocket.close` does that
      // itself, for the same reason). This fallback is what lets `1667 web`
      // exit after SIGINT with a bridge connected; it is a no-op timer that
      // clears immediately in the plain-HTTP case, where `close` already
      // resolves this way well within the window.
      const fallback = setTimeout(() => settle(), 500);
    })
  };
}

function isAlreadyClosed(error: NodeJS.ErrnoException): boolean {
  return error.code === "ERR_SERVER_NOT_RUNNING";
}

/** The one credential an upgrade needs to authorize a bridge connection —
 * `authorizeRequest`'s "websocket" mode needs no more than this, so
 * `host/web-bridge-server.ts` can share it without importing the rest of
 * this module's private per-run state. */
export interface AuthorizationContext {
  readonly port: number;
  readonly tokenBuffer: Buffer;
}

interface RequestContext extends AuthorizationContext {
  readonly projectLabel: string;
  readonly version: string;
}

interface RouteResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

interface Route {
  readonly path: string;
  readonly methods: ReadonlySet<string>;
  readonly credential: "none" | "bearer";
  readonly handle: (context: RequestContext) => RouteResponse;
}

const ROUTES: readonly Route[] = [
  {
    path: "/",
    methods: new Set(["GET", "HEAD"]),
    credential: "none",
    handle: () => ({ status: 200, contentType: "text/html; charset=utf-8", body: WEB_SHELL_HTML })
  },
  {
    path: "/app.js",
    methods: new Set(["GET", "HEAD"]),
    credential: "none",
    handle: () => ({ status: 200, contentType: "text/javascript; charset=utf-8", body: WEB_APP_JS })
  },
  {
    path: "/api/status",
    methods: new Set(["GET"]),
    credential: "bearer",
    handle: (context) => ({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify({ project: context.projectLabel, version: context.version })
    })
  }
];

function findRoute(pathname: string): Route | undefined {
  return ROUTES.find((route) => route.path === pathname);
}

type Authorization =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: 401 | 403; readonly page: string };

/** How a request proves it may proceed. An ordinary page route needs
 * nothing (`"none"`); `/api/status` needs the bearer token (`"bearer"`);
 * `host/web-bridge-server.ts`'s upgrade needs the stronger `"websocket"`
 * proof below — Origin is required rather than merely checked when present,
 * and the token travels as a `Sec-WebSocket-Protocol` offer instead of an
 * `Authorization` header, because an upgrade request carries no such header. */
export type AuthorizationCredential = "none" | "bearer" | "websocket";

/**
 * The DNS-rebinding and token gate every request passes through, in order:
 * the `Host` header, then `Origin`, then the credential itself. It works
 * from an `IncomingMessage` alone (no `ServerResponse`), so
 * `host/web-bridge-server.ts`'s `upgrade` handler calls this same function
 * before a response exists — an upgrade refusal can write no HTTP status at
 * all, only destroy the socket, so `status`/`page` go unread there.
 */
export function authorizeRequest(
  request: IncomingMessage,
  context: AuthorizationContext,
  credential: AuthorizationCredential
): Authorization {
  if (!validHost(request.headers.host, context.port)) {
    return { ok: false, status: 403, page: simplePage("Forbidden.") };
  }
  const origin = request.headers.origin;
  if (credential === "websocket") {
    if (origin === undefined || !validOrigin(origin, context.port)) {
      return { ok: false, status: 403, page: simplePage("Forbidden.") };
    }
    const protocols = offeredProtocols(request.headers["sec-websocket-protocol"]);
    if (!protocols.includes(WEB_BRIDGE_SUBPROTOCOL)
      || !matchesToken(bridgeTokenOffer(protocols), context.tokenBuffer)) {
      return {
        ok: false,
        status: 401,
        page: simplePage("Open the address that <code>1667 web</code> printed in the terminal.")
      };
    }
    return { ok: true };
  }
  if (origin !== undefined && !validOrigin(origin, context.port)) {
    return { ok: false, status: 403, page: simplePage("Forbidden.") };
  }
  if (credential === "bearer" && !matchesToken(bearerToken(request.headers.authorization), context.tokenBuffer)) {
    return {
      ok: false,
      status: 401,
      page: simplePage("Open the address that <code>1667 web</code> printed in the terminal.")
    };
  }
  return { ok: true };
}

function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: RequestContext
): void {
  try {
    // Already upper-case: https://nodejs.org/api/http.html#messagemethod
    const method = request.method ?? "GET";
    let pathname: string;
    try {
      pathname = new URL(request.url ?? "/", "http://web.1667.invalid").pathname;
    } catch {
      return sendPage(response, method, 400, simplePage("Bad request."), context.port);
    }
    const route = findRoute(pathname);
    const authorization = authorizeRequest(request, context, route?.credential ?? "none");
    if (!authorization.ok) {
      return sendPage(response, method, authorization.status, authorization.page, context.port);
    }
    if (route === undefined) {
      return sendPage(response, method, 404, simplePage("Not found."), context.port);
    }
    if (!route.methods.has(method)) {
      return sendPage(response, method, 405, simplePage("Method not allowed."), context.port);
    }
    const result = route.handle(context);
    return send(response, method, result.status, result.contentType, result.body, context.port);
  } catch {
    // A bug here still has to answer the socket, not crash the process.
    try {
      response.writeHead(500, { "content-type": "text/html; charset=utf-8", ...securityHeaders(context.port) });
      response.end(request.method === "HEAD" ? undefined : simplePage("Internal error."));
    } catch {
      // The socket may already be unusable; there is nothing more to do.
    }
  }
}

/** The exact loopback host strings this port answers to. Port 80 also
 * accepts the bare form, because a browser omits the default port from both
 * `Host` and `Origin`. */
function loopbackHostForms(port: number): readonly string[] {
  const qualified = [`127.0.0.1:${port}`, `localhost:${port}`];
  return port === 80 ? [...qualified, "127.0.0.1", "localhost"] : qualified;
}

function validHost(host: string | undefined, port: number): boolean {
  return host !== undefined && loopbackHostForms(port).includes(host);
}

function validOrigin(origin: string, port: number): boolean {
  return loopbackHostForms(port).some((host) => origin === `http://${host}`);
}

function bearerToken(header: string | undefined): string | null {
  return header !== undefined && header.startsWith(BEARER_PREFIX)
    ? header.slice(BEARER_PREFIX.length)
    : null;
}

/** `Sec-WebSocket-Protocol` is one comma-separated header line, one offer
 * per entry (verified against Bun 1.3.14: a client's `protocols` array
 * arrives this way, and `ws`'s `handleProtocols` receives it split into a
 * `Set`). */
function offeredProtocols(header: string | undefined): readonly string[] {
  return header === undefined
    ? []
    : header.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function bridgeTokenOffer(protocols: readonly string[]): string | null {
  const offer = protocols.find((protocol) => protocol.startsWith(WEB_BRIDGE_TOKEN_PREFIX));
  return offer === undefined ? null : offer.slice(WEB_BRIDGE_TOKEN_PREFIX.length);
}

/** A candidate of the wrong shape compares against a same-length dummy, so
 * every call reaches `timingSafeEqual` and no branch reveals candidate shape. */
function matchesToken(candidate: string | null, tokenBuffer: Buffer): boolean {
  const decoded = candidate !== null && TOKEN_HEX_PATTERN.test(candidate)
    ? Buffer.from(candidate, "hex")
    : INVALID_TOKEN;
  return timingSafeEqual(decoded, tokenBuffer);
}

function send(
  response: ServerResponse,
  method: string,
  status: number,
  contentType: string,
  body: string,
  port: number
): void {
  const payload = Buffer.from(body, "utf8");
  response.writeHead(status, {
    "content-type": contentType,
    "content-length": String(payload.length),
    ...securityHeaders(port)
  });
  if (method === "HEAD") response.end();
  else response.end(payload);
}

function sendPage(
  response: ServerResponse,
  method: string,
  status: number,
  body: string,
  port: number
): void {
  send(response, method, status, "text/html; charset=utf-8", body, port);
}

function simplePage(bodyHtml: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>1667</title></head>
<body><p>${bodyHtml}</p></body></html>
`;
}
