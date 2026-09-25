import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from "node:http";
import { listenLoopback } from "../server/loopback-listen.js";
import { WEB_APP_JS, WEB_SHELL_HTML } from "./web-placeholder.js";

/** 32 random bytes, hex-encoded: matches the story-scope capability length,
 * so a candidate of the wrong shape never reaches `timingSafeEqual` with
 * mismatched buffer lengths. */
const TOKEN_BYTES = 32;
const TOKEN_HEX_PATTERN = /^[0-9a-f]{64}$/;
const INVALID_TOKEN = Buffer.alloc(TOKEN_BYTES);
const BEARER_PREFIX = "Bearer ";

const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'none'; script-src 'self'; connect-src 'self'; "
    + "style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "x-frame-options": "DENY"
} as const;

export interface WebServerOptions {
  readonly port: number;
  /** The project root, shown on the placeholder page. */
  readonly projectLabel: string;
  /** The running build's version, shown on the placeholder page. */
  readonly version: string;
}

export interface WebServer {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

/**
 * A small loopback HTTP server for `1667 web`. Every route is guarded by a
 * per-run token minted here and handed to the caller only in the URL
 * fragment — unlike a cookie, a fragment is never sent to another loopback
 * port, so a malicious local service on a different port cannot replay it.
 * It does not touch the story backend; the caller holds that separately.
 */
export async function startWebServer(options: WebServerOptions): Promise<WebServer> {
  const server = createServer();
  await listenLoopback(server, options.port);
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("1667 web server bound without a loopback network address");
  }
  const token = randomBytes(TOKEN_BYTES).toString("hex");
  const context: RequestContext = {
    port: address.port,
    tokenBuffer: Buffer.from(token, "hex"),
    projectLabel: options.projectLabel,
    version: options.version
  };
  server.on("request", (request, response) => {
    handleRequest(request, response, context);
  });
  return {
    url: `http://127.0.0.1:${address.port}/#token=${token}`,
    port: address.port,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined || isAlreadyClosed(error)) resolve();
        else reject(error);
      });
      // Idle keep-alive sockets otherwise hold `close()` open indefinitely;
      // the placeholder page has nothing worth draining gracefully for.
      server.closeAllConnections();
    })
  };
}

function isAlreadyClosed(error: NodeJS.ErrnoException): boolean {
  return error.code === "ERR_SERVER_NOT_RUNNING";
}

interface RequestContext {
  readonly port: number;
  readonly tokenBuffer: Buffer;
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
  readonly requireBearer: boolean;
  readonly handle: (context: RequestContext) => RouteResponse;
}

const ROUTES: readonly Route[] = [
  {
    path: "/",
    methods: new Set(["GET", "HEAD"]),
    requireBearer: false,
    handle: () => ({ status: 200, contentType: "text/html; charset=utf-8", body: WEB_SHELL_HTML })
  },
  {
    path: "/app.js",
    methods: new Set(["GET", "HEAD"]),
    requireBearer: false,
    handle: () => ({ status: 200, contentType: "text/javascript; charset=utf-8", body: WEB_APP_JS })
  },
  {
    path: "/api/status",
    methods: new Set(["GET"]),
    requireBearer: true,
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

/**
 * The DNS-rebinding and bearer-token gate every request passes through, in
 * order: the `Host` header, then `Origin` when present, then the bearer
 * token for a route that requires one. It works from an `IncomingMessage`
 * alone (no `ServerResponse`), so step 2's WebSocket `upgrade` handler can
 * call this same function before a response exists.
 */
export function authorizeRequest(
  request: IncomingMessage,
  context: RequestContext,
  requireBearer: boolean
): Authorization {
  if (!validHost(request.headers.host, context.port)) {
    return { ok: false, status: 403, page: simplePage("Forbidden.") };
  }
  const origin = request.headers.origin;
  if (origin !== undefined && !validOrigin(origin, context.port)) {
    return { ok: false, status: 403, page: simplePage("Forbidden.") };
  }
  if (requireBearer && !matchesToken(bearerToken(request.headers.authorization), context.tokenBuffer)) {
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
      return sendPage(response, method, 400, simplePage("Bad request."));
    }
    const route = findRoute(pathname);
    const authorization = authorizeRequest(request, context, route?.requireBearer ?? false);
    if (!authorization.ok) {
      return sendPage(response, method, authorization.status, authorization.page);
    }
    if (route === undefined) {
      return sendPage(response, method, 404, simplePage("Not found."));
    }
    if (!route.methods.has(method)) {
      return sendPage(response, method, 405, simplePage("Method not allowed."));
    }
    const result = route.handle(context);
    return send(response, method, result.status, result.contentType, result.body);
  } catch {
    // A bug here still has to answer the socket, not crash the process.
    try {
      response.writeHead(500, { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS });
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
  body: string
): void {
  const payload = Buffer.from(body, "utf8");
  response.writeHead(status, {
    "content-type": contentType,
    "content-length": String(payload.length),
    ...SECURITY_HEADERS
  });
  if (method === "HEAD") response.end();
  else response.end(payload);
}

function sendPage(response: ServerResponse, method: string, status: number, body: string): void {
  send(response, method, status, "text/html; charset=utf-8", body);
}

function simplePage(bodyHtml: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>1667</title></head>
<body><p>${bodyHtml}</p></body></html>
`;
}
