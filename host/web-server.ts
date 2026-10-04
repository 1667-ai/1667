import { randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { brotliCompress, constants as zlibConstants, gzip } from "node:zlib";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import { listenLoopback } from "../server/loopback-listen.js";
import { ownedLoopbackHttpSupportedOn } from "../shared/provider-transport-capability.js";
import type { ReadingPositions } from "../shared/reading-position.js";
import {
  WEB_BRIDGE_SUBPROTOCOL,
  WEB_BRIDGE_TOKEN_PREFIX
} from "../shared/web-bridge-protocol.js";
import {
  readingPositionsGetRoute,
  readingPositionsPutRoute
} from "./web-reading-positions-routes.js";

/** 32 random bytes, hex-encoded: matches the story-scope capability length,
 * so a candidate of the wrong shape never reaches `timingSafeEqual` with
 * mismatched buffer lengths. */
const WEB_TOKEN_BYTES = 32;
const TOKEN_HEX_PATTERN = /^[0-9a-f]{64}$/;
const INVALID_TOKEN = Buffer.alloc(WEB_TOKEN_BYTES);
const BEARER_PREFIX = "Bearer ";

/** Mint one per-run token. Minted and kept inside `startWebServer`: neither
 * the caller (`cli/src/web-command.ts`) nor `host/web-bridge-server.ts` ever
 * holds the raw token — the server hands out `url` (which carries it once,
 * for the browser) and `authorizeUpgrade` (which checks it, for the bridge). */
function generateWebToken(): string {
  return randomBytes(WEB_TOKEN_BYTES).toString("hex");
}

/** A CSP is loopback-only and depends on the run's own port: Safari does not
 * treat `'self'` as covering a same-origin `ws:` connection, so the bridge
 * origin is named explicitly, in both host forms `loopbackHostForms` accepts.
 * No inline script or style (`'unsafe-inline'` is gone): the theme override
 * goes on before paint through `data-theme`/`data-palette` attributes
 * (`web/src/main.tsx`), not a pre-paint `<script>`, and React's `style={{}}`
 * props go through the CSSOM rather than an inline `style` attribute value,
 * so neither needs it. */
function securityHeaders(port: number): Record<string, string> {
  return {
    "content-security-policy": "default-src 'none'; script-src 'self'; "
      + "style-src 'self'; font-src 'self'; img-src 'self'; "
      + `connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port}; `
      + "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
    "x-frame-options": "DENY"
  };
}

/** The app bundle's static files, served publicly: `cli/src/web-assets.ts`
 * builds `"/"` (`web/index.html`) plus one hashed `/assets/*` entry per Vite
 * output chunk, including binary fonts, so the body is raw bytes rather than
 * a UTF-8 string; this server does not care which paths are present, only
 * that every one of them is public GET/HEAD. */
export interface WebAsset {
  readonly contentType: string;
  readonly body: Uint8Array;
}

/** The small surface `startWebServer` needs to serve durable reading
 * positions — kept generic (no host-store import here) so this module stays
 * a plain HTTP server; `cli/src/web-command.ts` wires the host's own
 * `reading-position-store.ts` (the same store the embedded TUI reads and
 * writes) into it. `set`'s `null` deletes the story's stored position. */
export interface ReadingPositionsService {
  load(): Promise<ReadingPositions>;
  set(storyId: string, partId: string | null): void;
}

export interface WebServerOptions {
  readonly port: number;
  readonly assets: ReadonlyMap<string, WebAsset>;
  /** The project root, shown once `/api/status` is authorized. */
  readonly projectLabel: string;
  /** The running build's version, shown once `/api/status` is authorized. */
  readonly version: string;
  readonly readingPositions: ReadingPositionsService;
}

export interface WebServer {
  readonly url: string;
  readonly port: number;
  /** The raw listener, so `host/web-bridge-server.ts` can attach its own
   * `upgrade` handler to the exact same loopback socket rather than binding
   * a second port. */
  readonly httpServer: Server;
  /** The one credential `host/web-bridge-server.ts`'s `upgrade` handler
   * needs before it calls `wss.handleUpgrade`: Host valid, Origin required
   * and valid, the bridge subprotocol offered, and the per-run token offered
   * alongside it — checked against this server's own copy, which the caller
   * never sees. No HTTP status can be written once Node hands over the raw
   * socket for an upgrade, so a caller that gets `false` only destroys it. */
  authorizeUpgrade(request: IncomingMessage): boolean;
  close(): Promise<void>;
}

/**
 * A small loopback HTTP server for `1667 web`. Every route is guarded by a
 * per-run token, minted here and handed to the browser only in the URL
 * fragment — unlike a cookie, a fragment is never sent to another loopback
 * port, so a malicious local service on a different port cannot replay it.
 * The caller never sees the raw token itself, only `url` (which already
 * carries it) and `authorizeUpgrade` (which checks it). This server does not
 * touch the story backend; the caller holds that separately.
 */
export async function startWebServer(options: WebServerOptions): Promise<WebServer> {
  const server = createServer();
  await listenLoopback(server, options.port);
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("1667 web server bound without a loopback network address");
  }
  const token = generateWebToken();
  const context: RequestContext = {
    port: address.port,
    tokenBuffer: Buffer.from(token, "hex"),
    assets: options.assets,
    projectLabel: options.projectLabel,
    version: options.version,
    readingPositions: options.readingPositions
  };
  server.on("request", (request, response) => {
    void handleRequest(request, response, context);
  });
  return {
    url: `http://127.0.0.1:${address.port}/#token=${token}`,
    port: address.port,
    httpServer: server,
    authorizeUpgrade: (request) => authorizeUpgrade(request, context),
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
      // `host/web-bridge-server.ts`'s hub already destroys every upgraded
      // bridge socket itself before a caller closes this server (Bun does
      // not reliably hand one back through `closeAllConnections` on its
      // own), so this is a generic backstop, not a wait on that: a plain
      // `close` callback that never fires for some other reason still lets
      // `1667 web` exit.
      const fallback = setTimeout(() => settle(), 500);
    })
  };
}

function isAlreadyClosed(error: NodeJS.ErrnoException): boolean {
  return error.code === "ERR_SERVER_NOT_RUNNING";
}

export interface RequestContext {
  readonly port: number;
  readonly tokenBuffer: Buffer;
  readonly assets: ReadonlyMap<string, WebAsset>;
  readonly projectLabel: string;
  readonly version: string;
  readonly readingPositions: ReadingPositionsService;
}

export interface RouteResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

/** `match` names the path this route answers and pulls out any variable
 * segment (`storyId`, for the reading-positions PUT) in one step — `null`
 * means "not this route," so `findRoute` below just tries each in turn. */
export interface Route {
  readonly match: (pathname: string) => Readonly<Record<string, string>> | null;
  readonly methods: ReadonlySet<string>;
  readonly requireBearer: boolean;
  readonly handle: (
    context: RequestContext,
    request: IncomingMessage,
    params: Readonly<Record<string, string>>
  ) => RouteResponse | Promise<RouteResponse>;
}

/** Every path here is app data, never a static asset — those come from
 * `context.assets` instead (see `handleRequest`). */
const ROUTES: readonly Route[] = [
  {
    match: (pathname) => (pathname === "/api/status" ? {} : null),
    methods: new Set(["GET"]),
    requireBearer: true,
    handle: (context) => ({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify({
        project: context.projectLabel,
        version: context.version,
        // The server's platform decides whether plain-HTTP local providers
        // are supported, so the browser reads it here, not from its own.
        ownedLoopbackHttp: ownedLoopbackHttpSupportedOn(
          process.platform,
          typeof process.getuid === "function"
        )
      })
    })
  },
  readingPositionsGetRoute,
  readingPositionsPutRoute
];

function findRoute(pathname: string): { route: Route; params: Readonly<Record<string, string>> } | undefined {
  for (const route of ROUTES) {
    const params = route.match(pathname);
    if (params !== null) return { route, params };
  }
  return undefined;
}

type Authorization =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: 401 | 403; readonly page: string };

/**
 * The DNS-rebinding and token gate every ordinary request passes through, in
 * order: the `Host` header, then `Origin` (when present), then the bearer
 * token for a route that requires one. `host/web-bridge-server.ts`'s upgrade
 * uses the separate, stricter `authorizeUpgrade` below instead — an upgrade
 * has no response to answer with, so it needs no `Authorization` value back,
 * only a boolean.
 */
function authorizeRequest(
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

/**
 * The upgrade-only credential `host/web-bridge-server.ts`'s `upgrade`
 * handler needs before it calls `wss.handleUpgrade`: Host valid, Origin
 * REQUIRED and valid (unlike `authorizeRequest`, an upgrade has no same-origin
 * page to fall back on when Origin is absent), the bridge subprotocol
 * offered, and the per-run token offered alongside it as a
 * `Sec-WebSocket-Protocol` entry instead of an `Authorization` header,
 * because an upgrade request carries no such header. No HTTP status can be
 * written once Node hands over the raw socket for an upgrade, so a refusal
 * here is a plain `false`: the caller only destroys the socket.
 */
function authorizeUpgrade(request: IncomingMessage, context: RequestContext): boolean {
  if (!validHost(request.headers.host, context.port)) return false;
  const origin = request.headers.origin;
  if (origin === undefined || !validOrigin(origin, context.port)) return false;
  const protocols = offeredProtocols(request.headers["sec-websocket-protocol"]);
  return protocols.includes(WEB_BRIDGE_SUBPROTOCOL)
    && matchesToken(bridgeTokenOffer(protocols), context.tokenBuffer);
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: RequestContext
): Promise<void> {
  try {
    // Already upper-case: https://nodejs.org/api/http.html#messagemethod
    const method = request.method ?? "GET";
    let pathname: string;
    try {
      pathname = new URL(request.url ?? "/", "http://web.1667.invalid").pathname;
    } catch {
      return sendPage(response, method, 400, simplePage("Bad request."), context.port);
    }
    const found = findRoute(pathname);
    const authorization = authorizeRequest(request, context, found?.route.requireBearer ?? false);
    if (!authorization.ok) {
      return sendPage(response, method, authorization.status, authorization.page, context.port);
    }
    if (found !== undefined) {
      if (!found.route.methods.has(method)) {
        return sendPage(response, method, 405, simplePage("Method not allowed."), context.port);
      }
      const result = await found.route.handle(context, request, found.params);
      return send(response, method, result.status, result.contentType, result.body, context.port);
    }
    const asset = context.assets.get(pathname);
    if (asset !== undefined) {
      if (method !== "GET" && method !== "HEAD") {
        return sendPage(response, method, 405, simplePage("Method not allowed."), context.port);
      }
      return await sendAsset(response, method, pathname, asset, request.headers["accept-encoding"], context.port);
    }
    return sendPage(response, method, 404, simplePage("Not found."), context.port);
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

/** Hashed `/assets/*` files never change under one name, so a browser keeps
 * them for good. The shell page (`/`) names the current hashes, so it stays
 * `no-store` like every other response. */
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);

type Encoding = "br" | "gzip";

/** Compressed copies, made once per asset on its first request. The assets
 * never change while the server runs. */
const compressedAssets = new WeakMap<WebAsset, Map<Encoding, Promise<Buffer>>>();

function isCompressible(contentType: string): boolean {
  return contentType.startsWith("text/") || contentType.startsWith("application/json");
}

/** The best encoding the client accepts, or `null`. Quality values only
 * matter at `q=0` (refused). */
function acceptedEncoding(header: string | string[] | undefined): Encoding | null {
  if (typeof header !== "string") return null;
  const accepted = new Set<string>();
  for (const entry of header.split(",")) {
    const [name, ...parameters] = entry.trim().toLowerCase().split(";");
    const refused = parameters.some((parameter) => /^\s*q=0(\.0*)?\s*$/.test(parameter));
    if (name !== undefined && name.length > 0 && !refused) accepted.add(name);
  }
  if (accepted.has("br")) return "br";
  if (accepted.has("gzip")) return "gzip";
  return null;
}

function compressedCopy(asset: WebAsset, encoding: Encoding): Promise<Buffer> {
  let copies = compressedAssets.get(asset);
  if (copies === undefined) {
    copies = new Map();
    compressedAssets.set(asset, copies);
  }
  let copy = copies.get(encoding);
  if (copy === undefined) {
    copy = encoding === "br"
      ? brotliAsync(asset.body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 9 } })
      : gzipAsync(asset.body, { level: 9 });
    copies.set(encoding, copy);
  }
  return copy;
}

async function sendAsset(
  response: ServerResponse,
  method: string,
  pathname: string,
  asset: WebAsset,
  acceptEncoding: string | string[] | undefined,
  port: number
): Promise<void> {
  const extra: Record<string, string> = {};
  if (pathname.startsWith("/assets/")) extra["cache-control"] = IMMUTABLE_CACHE_CONTROL;
  if (!isCompressible(asset.contentType)) {
    return send(response, method, 200, asset.contentType, asset.body, port, extra);
  }
  extra["vary"] = "accept-encoding";
  const encoding = acceptedEncoding(acceptEncoding);
  if (encoding === null) {
    return send(response, method, 200, asset.contentType, asset.body, port, extra);
  }
  extra["content-encoding"] = encoding;
  send(response, method, 200, asset.contentType, await compressedCopy(asset, encoding), port, extra);
}

function send(
  response: ServerResponse,
  method: string,
  status: number,
  contentType: string,
  body: string | Uint8Array,
  port: number,
  extraHeaders: Readonly<Record<string, string>> = {}
): void {
  const payload = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  // A 204 carries no body by definition, so it carries no Content-Type
  // either — a route that answers one (the reading-positions PUT) always
  // passes an empty body alongside it; this is what actually drops the
  // header, rather than trusting every route to remember to omit it.
  const headers: Record<string, string> = {
    ...securityHeaders(port),
    ...extraHeaders,
    "content-length": String(payload.length)
  };
  if (status !== 204) headers["content-type"] = contentType;
  response.writeHead(status, headers);
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
