import {
  Agent,
  request,
  type ClientRequestArgs,
  type IncomingHttpHeaders
} from "node:http";
import { lookup } from "node:dns/promises";
import { isIP, Socket } from "node:net";
import { Readable, type Duplex } from "node:stream";
import { classifyHttpHost } from "../shared/http-host-class.js";
import { ProviderError } from "./errors.js";

const SENSITIVE_HEADERS = ["authorization", "proxy-authorization", "x-api-key"] as const;
const SAFE_HEADERS = new Set(["accept", "anthropic-version", "content-type"]);

export interface PinnedPrivateHttpPolicy {
  readonly allowPresetQuery?: boolean;
}

/** Credentialless private-LAN HTTP: resolve once, reject public answers, then
 * pin the exact peer address without proxying or connection pooling. */
export async function pinnedPrivateHttpFetch(
  input: string | URL,
  init: RequestInit = {},
  policy: PinnedPrivateHttpPolicy = {}
): Promise<Response> {
  const url = input instanceof URL ? input : new URL(input);
  const hostClass = classifyHttpHost(url.href);
  if (
    url.protocol !== "http:"
    || (hostClass !== "private-literal" && hostClass !== "lan-hostname")
    || url.username !== ""
    || url.password !== ""
    || (policy.allowPresetQuery !== true && url.href.includes("?"))
    || url.href.includes("#")
  ) {
    throw new ProviderError(
      "Private HTTP transport requires a canonical LAN host without credentials, query, or fragment."
    );
  }
  const headers = new Headers(init.headers);
  if (SENSITIVE_HEADERS.some((name) => headers.has(name))) {
    throw new ProviderError("Private HTTP provider requests cannot carry authentication.");
  }
  for (const name of headers.keys()) {
    if (!SAFE_HEADERS.has(name)) {
      throw new ProviderError("Private HTTP provider requests cannot carry custom headers.");
    }
  }
  headers.set("connection", "close");
  const body = requestBody(init.body);
  if (body !== null && !headers.has("content-length")) {
    headers.set("content-length", String(body.byteLength));
  }
  const pinnedAddress = await resolvePinnedLanAddress(url, hostClass);
  const agent = new PinnedAddressAgent(pinnedAddress);
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
      resolve(new Response(
        status === 204 || status === 205 || status === 304
          ? null
          : Readable.toWeb(incoming) as ReadableStream<Uint8Array>,
        {
          status,
          statusText: incoming.statusMessage,
          headers: responseHeaders(incoming.headers)
        }
      ));
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

export class PinnedAddressAgent extends Agent {
  private readonly pending = new Map<Socket, (error: Error | null) => void>();

  constructor(
    private readonly expectedAddress: string,
    private readonly connectAddress = expectedAddress
  ) {
    super({ keepAlive: false, maxSockets: 1 });
  }

  override createConnection(
    options: ClientRequestArgs,
    callback?: (error: Error | null, stream: Duplex) => void
  ): Duplex | null {
    const socket = new Socket();
    let completed = false;
    const finish = (error: Error | null) => {
      if (completed) return;
      completed = true;
      this.pending.delete(socket);
      if (error !== null) socket.destroy();
      callback?.(error, socket);
    };
    this.pending.set(socket, finish);
    socket.once("error", finish);
    socket.connect({
      host: this.connectAddress,
      port: requiredPort(options)
    }, () => {
      const remote = socket.remoteAddress;
      if (remote === undefined || !sameAddress(this.expectedAddress, remote)) {
        finish(new ProviderError("Private HTTP provider connected to an unexpected peer address."));
        return;
      }
      finish(null);
    });
    return null;
  }

  override destroy(): void {
    for (const finish of [...this.pending.values()]) {
      finish(new ProviderError("Private HTTP provider connection was closed."));
    }
    super.destroy();
  }
}

async function resolvePinnedLanAddress(
  url: URL,
  hostClass: "private-literal" | "lan-hostname"
): Promise<string> {
  const host = unbracketed(url.hostname);
  if (hostClass === "private-literal") return host;
  const answers = await lookup(host, { all: true, verbatim: true });
  if (answers.length === 0 || answers.some(({ address }) => !isLanPeerAddress(address))) {
    throw new ProviderError("LAN HTTP provider resolved outside the private network.");
  }
  return answers[0]!.address;
}

export function isLanPeerAddress(address: string): boolean {
  const host = unbracketed(address).toLowerCase();
  const literalUrl = isIP(host) === 6 ? `http://[${host}]` : `http://${host}`;
  const classified = classifyHttpHost(literalUrl);
  return classified === "loopback"
    || classified === "private-literal";
}

function sameAddress(expected: string, actual: string): boolean {
  const left = normalizedIp(expected);
  const right = normalizedIp(actual);
  return left !== null && right !== null && left === right;
}

function normalizedIp(value: string): string | null {
  const address = unbracketed(value).toLowerCase();
  if (isIP(address) === 4) return address.split(".").map(Number).join(".");
  if (isIP(address) !== 6) return null;
  if (address.startsWith("::ffff:") && isIP(address.slice(7)) === 4) {
    return address.slice(7).split(".").map(Number).join(".");
  }
  return expandIpv6(address);
}

function expandIpv6(value: string): string | null {
  const [leftText, rightText = ""] = value.split("::");
  const left = leftText!.length === 0 ? [] : leftText!.split(":");
  const right = rightText.length === 0 ? [] : rightText.split(":");
  const omitted = 8 - left.length - right.length;
  if ((!value.includes("::") && omitted !== 0) || omitted < 0) return null;
  const groups = [...left, ...Array.from({ length: omitted }, () => "0"), ...right];
  return groups.length === 8
    ? groups.map((group) => Number.parseInt(group, 16).toString(16)).join(":")
    : null;
}

function requestBody(body: BodyInit | null | undefined): Buffer | null {
  if (body === undefined || body === null) return null;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  throw new ProviderError("Private HTTP transport supports only bounded byte request bodies.");
}

function responseHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) value.forEach((item) => result.append(name, item));
    else result.set(name, value);
  }
  return result;
}

function requiredPort(options: ClientRequestArgs): number {
  const value = options.port === undefined
    ? 80
    : typeof options.port === "string" ? Number(options.port) : options.port;
  if (!Number.isInteger(value) || value! < 1 || value! > 65_535) {
    throw new ProviderError("Private HTTP provider port is invalid.");
  }
  return value!;
}

function unbracketed(value: string): string {
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}
