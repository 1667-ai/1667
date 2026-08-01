import { readFile } from "node:fs/promises";
import {
  Agent,
  request,
  type ClientRequestArgs,
  type IncomingHttpHeaders
} from "node:http";
import { isIP, Socket } from "node:net";
import { Readable, type Duplex } from "node:stream";
import { classifyHttpHost } from "../shared/http-host-class.js";
import { ownedLoopbackHttpSupportedOn } from "../shared/provider-transport-capability.js";
import { ProviderError } from "./errors.js";
import { pinnedPrivateHttpFetch } from "./provider-private-http.js";

const LINUX_TCP_TABLES = ["/proc/net/tcp", "/proc/net/tcp6"] as const;
const SAFE_PLAINTEXT_HEADERS = new Set([
  "accept",
  "anthropic-version",
  "content-type"
]);
const SENSITIVE_PLAINTEXT_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key"
]);
const OWNER_LOOKUP_ATTEMPTS = 50;
const OWNER_LOOKUP_RETRY_MS = 10;

export interface LoopbackSocketTuple {
  readonly localAddress: string;
  readonly localPort: number;
  readonly remoteAddress: string;
  readonly remotePort: number;
}

export type LoopbackOwnerResolver =
  (tuple: LoopbackSocketTuple) => Promise<number | null>;

export interface ProviderFetchPolicy {
  readonly allowInsecurePrivateHttp?: boolean;
}

/** HTTPS stays on Fetch. Credentialless loopback HTTP uses a fresh direct
 * socket whose accepted peer is proven to belong to this account first. */
export async function providerFetch(
  input: string | URL,
  init: RequestInit = {},
  policy: ProviderFetchPolicy = {}
): Promise<Response> {
  return await providerFetchInternal(input, init, false, policy);
}

/** Presets may compose an explicitly modeled, non-secret query after matching
 * provider-owned metadata. Stored/user-supplied provider URLs remain query-free. */
export async function providerFetchWithPresetQuery(
  input: string | URL,
  init: RequestInit = {},
  policy: ProviderFetchPolicy = {}
): Promise<Response> {
  return await providerFetchInternal(input, init, true, policy);
}

async function providerFetchInternal(
  input: string | URL,
  init: RequestInit,
  allowPresetQuery: boolean,
  policy: ProviderFetchPolicy
): Promise<Response> {
  const url = input instanceof URL ? input : new URL(input);
  if (url.username !== "" || url.password !== "" || url.href.includes("#")) {
    throw new ProviderError("Provider URLs cannot contain credentials or fragments.");
  }
  if (url.protocol === "https:") {
    return await fetch(new Request(url, { ...init, redirect: "manual" }));
  }
  const hostClass = url.protocol === "http:" ? classifyHttpHost(url.href) : "other";
  if (
    (hostClass === "private-literal" || hostClass === "lan-hostname")
    && policy.allowInsecurePrivateHttp === true
  ) {
    return await pinnedPrivateHttpFetch(url, init, { allowPresetQuery });
  }
  // A model server on this machine must not be harder to reach than the same
  // server on the network. Where the account-ownership proof exists it still
  // runs, unchanged and without asking; where it does not, this endpoint falls
  // back to the same explicit opt-in a private LAN address already takes.
  // Neither path may carry credentials, so the opt-in covers exactly one thing:
  // plaintext traffic to a listener the program cannot attribute.
  if (
    hostClass === "loopback"
    && !ownedLoopbackHttpSupported()
    && policy.allowInsecurePrivateHttp === true
  ) {
    return await pinnedPrivateHttpFetch(url, init, { allowPresetQuery });
  }
  if (url.protocol !== "http:" || hostClass !== "loopback") {
    throw new ProviderError("Plain HTTP provider requests require a loopback endpoint.");
  }
  return await ownedLoopbackFetchInternal(
    url,
    init,
    resolveLinuxLoopbackServerUid,
    allowPresetQuery
  );
}

export function ownedLoopbackHttpSupported(): boolean {
  return ownedLoopbackHttpSupportedOn(
    process.platform,
    typeof process.getuid === "function"
  );
}

/** Exported for the exact-socket race fixtures; production callers use
 * providerFetch so the resolver cannot be replaced by application input. */
export async function ownedLoopbackFetch(
  input: string | URL,
  init: RequestInit = {},
  resolveOwner: LoopbackOwnerResolver = resolveLinuxLoopbackServerUid
): Promise<Response> {
  return await ownedLoopbackFetchInternal(input, init, resolveOwner, false);
}

async function ownedLoopbackFetchInternal(
  input: string | URL,
  init: RequestInit,
  resolveOwner: LoopbackOwnerResolver,
  allowPresetQuery: boolean
): Promise<Response> {
  const url = input instanceof URL ? input : new URL(input);
  if (url.protocol !== "http:" || classifyHttpHost(url.href) !== "loopback") {
    throw new ProviderError("Owned loopback transport requires a plain HTTP loopback URL.");
  }
  if (
    url.username !== ""
    || url.password !== ""
    || (!allowPresetQuery && url.href.includes("?"))
    || url.href.includes("#")
  ) {
    throw new ProviderError(
      "Plain HTTP loopback URLs cannot contain credentials, a query, or a fragment."
    );
  }
  if (!ownedLoopbackHttpSupported() && resolveOwner === resolveLinuxLoopbackServerUid) {
    throw new ProviderError(
      "This release target cannot prove that a plain HTTP loopback server belongs to your account; turn on insecure HTTP in Settings to reach it anyway, or configure an authenticated HTTPS endpoint."
    );
  }

  const headers = new Headers(init.headers);
  for (const name of SENSITIVE_PLAINTEXT_HEADERS) {
    if (headers.has(name)) {
      throw new ProviderError("Plain HTTP provider requests cannot carry authentication.");
    }
  }
  for (const name of headers.keys()) {
    if (!SAFE_PLAINTEXT_HEADERS.has(name)) {
      throw new ProviderError(
        "Plain HTTP provider requests cannot carry custom headers."
      );
    }
  }
  headers.set("connection", "close");

  const agent = new OwnedLoopbackAgent(resolveOwner);
  const body = requestBody(init.body);
  if (body !== null && !headers.has("content-length")) {
    headers.set("content-length", String(body.byteLength));
  }

  return await new Promise<Response>((resolve, reject) => {
    const outgoing = request(url, {
      method: init.method ?? "GET",
      headers: Object.fromEntries(headers.entries()),
      agent,
      signal: init.signal ?? undefined,
      maxHeaderSize: 64 * 1024
    }, (incoming) => {
      const status = incoming.statusCode ?? 0;
      if (status < 200 || status > 599) {
        incoming.destroy();
        reject(new ProviderError("Model server returned an invalid HTTP status."));
        return;
      }
      const responseHeaders = responseHeaderBag(incoming.headers);
      const noBody = status === 204 || status === 205 || status === 304;
      const stream = noBody
        ? null
        : Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
      resolve(new Response(stream, {
        status,
        statusText: incoming.statusMessage,
        headers: responseHeaders
      }));
    });
    outgoing.once("upgrade", (_response, socket) => {
      socket.destroy();
      agent.destroy();
      reject(new ProviderError("Model server attempted an unsupported HTTP protocol upgrade."));
    });
    outgoing.once("connect", (_response, socket) => {
      socket.destroy();
      agent.destroy();
      reject(new ProviderError("Model server attempted an unsupported HTTP tunnel."));
    });
    outgoing.once("error", (error) => {
      agent.destroy();
      reject(error);
    });
    if (body === null) outgoing.end();
    else outgoing.end(body);
  });
}

class OwnedLoopbackAgent extends Agent {
  private readonly pending = new Set<Socket>();

  constructor(private readonly resolveOwner: LoopbackOwnerResolver) {
    super({ keepAlive: false, maxSockets: 1 });
  }

  override createConnection(
    options: ClientRequestArgs,
    callback?: (error: Error | null, stream: Duplex) => void
  ): Duplex | null {
    const host = requiredHost(options);
    const port = requiredPort(options);
    const socket = new Socket();
    this.pending.add(socket);
    let completed = false;
    const finish = (error: Error | null) => {
      if (completed) return;
      completed = true;
      this.pending.delete(socket);
      if (error !== null) socket.destroy();
      callback?.(error, socket);
    };
    socket.once("error", finish);
    socket.connect({ host, port, autoSelectFamily: true }, () => {
      void this.verify(socket).then(() => finish(null), (error: unknown) => {
        finish(error instanceof Error ? error : new Error(String(error)));
      });
    });
    return null;
  }

  override destroy(): void {
    for (const socket of this.pending) socket.destroy();
    this.pending.clear();
    super.destroy();
  }

  private async verify(socket: Socket): Promise<void> {
    const tuple = socketTuple(socket);
    if (!isLoopbackAddress(tuple.remoteAddress)) {
      throw new ProviderError("Loopback provider resolved to a non-loopback peer.");
    }
    const expectedUid = process.getuid?.();
    if (expectedUid === undefined) {
      throw new ProviderError("This release target cannot verify loopback provider ownership.");
    }
    await this.requireCurrentOwner(socket, tuple, expectedUid);
    const current = socketTuple(socket);
    if (!sameTuple(tuple, current)) {
      throw new ProviderError("Loopback provider socket changed during ownership verification.");
    }
    await this.requireCurrentOwner(socket, current, expectedUid);
  }

  private async requireCurrentOwner(
    socket: Socket,
    tuple: LoopbackSocketTuple,
    expectedUid: number
  ): Promise<void> {
    let observedUid: number | null = null;
    for (let attempt = 0; attempt < OWNER_LOOKUP_ATTEMPTS; attempt += 1) {
      if (!sameTuple(tuple, socketTuple(socket))) {
        throw new ProviderError("Loopback provider socket changed during ownership verification.");
      }
      observedUid = await this.resolveOwner(tuple);
      if (observedUid === expectedUid) return;
      if (attempt + 1 < OWNER_LOOKUP_ATTEMPTS) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, OWNER_LOOKUP_RETRY_MS)
        );
      }
    }
    throw ownershipError(observedUid);
  }
}

export async function resolveLinuxLoopbackServerUid(
  tuple: LoopbackSocketTuple
): Promise<number | null> {
  if (process.platform !== "linux") return null;
  const tables = await Promise.all(LINUX_TCP_TABLES.map(async (path) => {
    try {
      return await readFile(path, "utf8");
    } catch {
      return "";
    }
  }));
  return linuxLoopbackServerUid(tuple, tables);
}

export function linuxLoopbackServerUid(
  tuple: LoopbackSocketTuple,
  tables: readonly string[]
): number | null {
  const local = packedAddress(tuple.localAddress);
  const remote = packedAddress(tuple.remoteAddress);
  if (local === null || remote === null) return null;
  for (const table of tables) {
    for (const line of table.split("\n").slice(1)) {
      const columns = line.trim().split(/\s+/u);
      if (columns.length < 8 || columns[3] !== "01") continue;
      const server = parseProcEndpoint(columns[1]!);
      const client = parseProcEndpoint(columns[2]!);
      if (server === null || client === null) continue;
      if (
        server.port === tuple.remotePort
        && client.port === tuple.localPort
        && equalBytes(server.address, remote)
        && equalBytes(client.address, local)
      ) {
        const uid = Number(columns[7]);
        return Number.isSafeInteger(uid) && uid >= 0 ? uid : null;
      }
    }
  }
  return null;
}

function requestBody(body: BodyInit | null | undefined): Buffer | null {
  if (body === undefined || body === null) return null;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  throw new ProviderError("Owned loopback transport supports only bounded byte request bodies.");
}

function responseHeaderBag(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) result.append(name, item);
    } else {
      result.set(name, value);
    }
  }
  return result;
}

function requiredHost(options: ClientRequestArgs): string {
  const value = options.hostname ?? options.host;
  if (typeof value !== "string" || value.length === 0) {
    throw new ProviderError("Loopback provider host is missing.");
  }
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}

function requiredPort(options: ClientRequestArgs): number {
  const value = options.port === undefined
    ? 80
    : typeof options.port === "string"
      ? Number(options.port)
      : options.port;
  if (!Number.isInteger(value) || value! < 1 || value! > 65_535) {
    throw new ProviderError("Loopback provider port is invalid.");
  }
  return value!;
}

function socketTuple(socket: Socket): LoopbackSocketTuple {
  const { localAddress, localPort, remoteAddress, remotePort } = socket;
  if (
    localAddress === undefined
    || localPort === undefined
    || remoteAddress === undefined
    || remotePort === undefined
  ) {
    throw new ProviderError("Loopback provider socket did not expose its established tuple.");
  }
  return { localAddress, localPort, remoteAddress, remotePort };
}

function sameTuple(left: LoopbackSocketTuple, right: LoopbackSocketTuple): boolean {
  return left.localAddress === right.localAddress
    && left.localPort === right.localPort
    && left.remoteAddress === right.remoteAddress
    && left.remotePort === right.remotePort;
}

function ownershipError(uid: number | null): ProviderError {
  return new ProviderError(uid === null
    ? "Could not prove that the loopback model server belongs to the current account; use authenticated HTTPS."
    : "The loopback model server belongs to a different account; use authenticated HTTPS.");
}

function isLoopbackAddress(value: string): boolean {
  const address = value.startsWith("::ffff:") ? value.slice(7) : value;
  return address === "::1" || (isIP(address) === 4 && address.startsWith("127."));
}

function parseProcEndpoint(value: string): { address: Uint8Array; port: number } | null {
  const separator = value.lastIndexOf(":");
  if (separator < 0) return null;
  const address = procAddress(value.slice(0, separator));
  const port = Number.parseInt(value.slice(separator + 1), 16);
  return address === null || !Number.isInteger(port) ? null : { address, port };
}

function procAddress(value: string): Uint8Array | null {
  if (!/^(?:[0-9A-F]{8}|[0-9A-F]{32})$/u.test(value)) return null;
  const bytes = Buffer.from(value, "hex");
  for (let offset = 0; offset < bytes.length; offset += 4) {
    bytes.subarray(offset, offset + 4).reverse();
  }
  return normalizedAddress(bytes);
}

function packedAddress(value: string): Uint8Array | null {
  const address = value.split("%", 1)[0]!;
  if (isIP(address) === 4) {
    return normalizedAddress(Uint8Array.from(address.split(".").map(Number)));
  }
  if (isIP(address) !== 6) return null;
  const [leftText, rightText = ""] = address.split("::");
  const left = leftText!.length === 0 ? [] : leftText!.split(":");
  const right = rightText.length === 0 ? [] : rightText.split(":");
  if (!address.includes("::") && left.length !== 8) return null;
  const omitted = 8 - left.length - right.length;
  if (omitted < 0) return null;
  const groups = [...left, ...Array.from({ length: omitted }, () => "0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/iu.test(group))) return null;
  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    const parsed = Number.parseInt(group, 16);
    bytes[index * 2] = parsed >>> 8;
    bytes[index * 2 + 1] = parsed & 0xff;
  });
  return normalizedAddress(bytes);
}

function normalizedAddress(value: Uint8Array): Uint8Array {
  if (
    value.length === 16
    && value.subarray(0, 10).every((byte) => byte === 0)
    && value[10] === 0xff
    && value[11] === 0xff
  ) {
    return value.slice(12);
  }
  return value;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}
