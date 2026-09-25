import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import {
  WEB_BRIDGE_PATH,
  WEB_BRIDGE_SUBPROTOCOL
} from "../shared/web-bridge-protocol.js";
import type { WebServer } from "./web-server.js";
import { WebBridge, type BridgeSocket } from "./web-bridge.js";
import type { WorkerHost } from "./worker-host.js";

/** Bun's `ws` shim does not enforce its own `maxPayload` (verified against Bun
 * 1.3.14): `WsBridgeSocket` checks every inbound frame's byte length itself
 * and closes 1009 over this bound. Server-only policy — nothing on the
 * browser side reads it. */
const MAX_BRIDGE_MESSAGE_BYTES = 32 * 1024 * 1024;

/** One browser can open several tabs; each tab gets its own bridge over the
 * shared host, up to this many at once. Server-only policy — nothing on the
 * browser side reads it. */
const MAX_BRIDGE_CONNECTIONS = 8;

/**
 * Bun 1.3.14 upgrade quirks. Every delay and direct `Duplex` handle below
 * exists because of one of these; nothing else in this file needs to repeat
 * them.
 * - A hand-written RFC 6455 server on a Bun `node:http` upgrade socket does
 *   not work (writes never reach the client). Bun's builtin `ws` module does:
 *   `new WebSocketServer({ noServer: true })` plus this file's own `upgrade`
 *   listener calling `wss.handleUpgrade`.
 * - `ws`'s own `maxPayload` option is silently ignored, hence
 *   `MAX_BRIDGE_MESSAGE_BYTES` being enforced by hand in `WsBridgeSocket`.
 * - `ws`'s shim does not reliably release the raw upgrade socket back to the
 *   http server on its own: without `WsBridgeSocket`'s own direct
 *   `rawSocket.destroy()`, neither `server.close()`'s connection draining nor
 *   `closeAllConnections()` frees an already-upgraded socket, and `1667 web`
 *   never exits after SIGINT while a bridge is connected. `ws`'s own
 *   `terminate()` was not enough either — it did not unblock `server.close()`
 *   in the same probe. `WS_CLOSE_FRAME_DELIVERY_MS` is the pause between a
 *   graceful `ws.close()` and that direct `destroy()`, so the close frame has
 *   a moment to actually reach the client first.
 * - Once any connection has been upgraded, Bun's `node:http` server never
 *   invokes `close()`'s own callback at all, even after the above `destroy()`
 *   — `host/web-server.ts`'s `close()` keeps a generic timeout fallback for
 *   this, independent of anything in this file.
 */
const WS_CLOSE_FRAME_DELIVERY_MS = 200;

export interface WebBridgeHubOptions {
  /** Already started: this hub attaches its own `upgrade` handler to
   * `webServer.httpServer` rather than opening a second port, and checks
   * every upgrade through `webServer.authorizeUpgrade` — the per-run token
   * never leaves that module. */
  readonly webServer: WebServer;
  /** The one project `1667 web` opened. Every connection shares it — unlike
   * the removed desktop bridge, this hub owns no per-project registry. */
  readonly host: WorkerHost;
}

export interface WebBridgeHub {
  /** Publish the live recovery-warning snapshot (`host.recoveryWarnings`) to
   * every open connection, but only when it differs from the last snapshot
   * this hub broadcast — never a delta, so a tab that opened between two
   * dismissals never has to reconcile a partial view, and never a redundant
   * frame: `WorkerTransport` calls this on every mutating call while any
   * warning is outstanding, not only when the set of warnings changes. */
  broadcastRecoveryWarnings(): void;
  /** The server is stopping: close 1001 on every open connection and resolve
   * once every one of their raw sockets is actually destroyed. The http
   * server's own `closeAllConnections` does not reach an already-upgraded
   * socket (see the Bun quirks above), so the hub destroys each one itself. */
  close(): Promise<void>;
}

/**
 * Accept WebSocket bridge connections on `WEB_BRIDGE_PATH`, over the loopback
 * HTTP server `1667 web` already started. `noServer: true` plus this file's
 * own `upgrade` listener keeps every refusal — wrong path, wrong method, over
 * the connection cap, or a failed `authorizeUpgrade` — a bare
 * `socket.destroy()` with no HTTP response, because no status line can be
 * written once Node hands over the raw socket for an upgrade.
 */
export function startWebBridgeServer(options: WebBridgeHubOptions): WebBridgeHub {
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) =>
      protocols.has(WEB_BRIDGE_SUBPROTOCOL) ? WEB_BRIDGE_SUBPROTOCOL : false
  });
  const active = new Set<WebBridge>();
  const sockets = new Set<WsBridgeSocket>();
  // Seeded from the live snapshot at hub startup, not `null`: every new
  // connection's own `hello` already carries this exact snapshot (`WebBridge.start`
  // reads `host.recoveryWarnings` itself), so the first `broadcastRecoveryWarnings()`
  // call must compare against it too, not treat it as an unconditional first send.
  let lastBroadcastKey = recoveryWarningsKey(options.host.recoveryWarnings);

  const broadcastRecoveryWarnings = (): void => {
    const key = recoveryWarningsKey(options.host.recoveryWarnings);
    if (key === lastBroadcastKey) return;
    lastBroadcastKey = key;
    active.forEach((bridge) => bridge.publishRecoveryWarnings());
  };

  options.webServer.httpServer.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    let pathname: string;
    try {
      pathname = new URL(request.url ?? "/", "http://web.1667.invalid").pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== WEB_BRIDGE_PATH
      || request.method !== "GET"
      || request.headers.upgrade?.toLowerCase() !== "websocket") {
      socket.destroy();
      return;
    }
    if (active.size >= MAX_BRIDGE_CONNECTIONS) {
      socket.destroy();
      return;
    }
    if (!options.webServer.authorizeUpgrade(request)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      const wsSocket = new WsBridgeSocket(ws, socket);
      const bridge = new WebBridge({
        host: options.host,
        socket: wsSocket,
        onClosed: () => {
          active.delete(bridge);
          sockets.delete(wsSocket);
        },
        // A dismissal on this connection changes a snapshot every open
        // connection shares — broadcast it, not only this one's own view.
        onRecoveryWarningsChanged: broadcastRecoveryWarnings
      });
      active.add(bridge);
      sockets.add(wsSocket);
      bridge.start();
    });
  });

  // A worker failure is not this file's to report — `cli/src/web-command.ts`
  // already lets it propagate through `WorkerHost.failure` to `runCli`'s own
  // handler — but every open browser tab still needs to hear about it before
  // that unwind closes its socket out from under it.
  void options.host.failure.then((error) => {
    active.forEach((bridge) => bridge.fail(error));
  });

  return {
    broadcastRecoveryWarnings,
    close: async () => {
      const destroyed = [...sockets].map((socket) => socket.destroyed);
      active.forEach((bridge) => bridge.close(1001, "1667 web is stopping"));
      await Promise.all(destroyed);
    }
  };
}

/** A comparison key for "did the warning set actually change" — order-independent
 * (mutation ids, sorted), so two snapshots with the same warnings in a
 * different order still compare equal. `\u0000` never appears in a
 * mutation id, so it is a safe separator. */
function recoveryWarningsKey(warnings: readonly { mutationId: string }[]): string {
  return warnings.map((warning) => warning.mutationId).sort().join("\u0000");
}

/** Adapt a `ws` `WebSocket` to the transport-agnostic `BridgeSocket` shape
 * `host/web-bridge.ts` expects, enforcing the two frame rules that
 * `WebBridge` itself never has to know about: text frames only, and the
 * message-size bound (see the Bun quirks block above). */
class WsBridgeSocket implements BridgeSocket {
  private messageListener: ((data: string) => void) | null = null;
  private closeListener: ((code: number, reason: string) => void) | null = null;
  /** Resolves once `rawSocket` is actually destroyed — by `close()`'s own
   * fallback below, or because the other end closed it first. */
  readonly destroyed: Promise<void>;

  constructor(
    private readonly ws: WebSocket,
    private readonly rawSocket: Duplex
  ) {
    this.destroyed = rawSocket.destroyed
      ? Promise.resolve()
      : new Promise((resolve) => rawSocket.once("close", () => resolve()));
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        ws.close(1003, "1667 web: text frames only");
        return;
      }
      if (data.length > MAX_BRIDGE_MESSAGE_BYTES) {
        ws.close(1009, "1667 web: message too large");
        return;
      }
      this.messageListener?.(data.toString("utf8"));
    });
    ws.on("close", (code, reason) => {
      this.closeListener?.(code, reason.toString("utf8"));
    });
    // An unhandled "error" throws on an EventEmitter. A socket-level error
    // still has to close its bridge, the same as a normal close would.
    ws.on("error", () => {
      this.closeListener?.(1011, "1667 web: the bridge socket errored");
    });
  }

  send(data: string): void {
    this.ws.send(data);
  }

  close(code?: number, reason?: string): void {
    this.ws.close(code, reason);
    // Give the close frame above a moment to actually reach the client
    // before the fallback below drops the raw socket out from under it.
    setTimeout(() => {
      if (!this.rawSocket.destroyed) this.rawSocket.destroy();
    }, WS_CLOSE_FRAME_DELIVERY_MS);
  }

  on(event: "message", listener: (data: string) => void): void;
  on(event: "close", listener: (code: number, reason: string) => void): void;
  on(
    event: "message" | "close",
    listener: ((data: string) => void) | ((code: number, reason: string) => void)
  ): void {
    if (event === "message") this.messageListener = listener as (data: string) => void;
    else this.closeListener = listener as (code: number, reason: string) => void;
  }
}
