import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import {
  MAX_BRIDGE_CONNECTIONS,
  MAX_BRIDGE_MESSAGE_BYTES,
  WEB_BRIDGE_PATH,
  WEB_BRIDGE_SUBPROTOCOL
} from "../shared/web-bridge-protocol.js";
import {
  authorizeRequest,
  type AuthorizationContext
} from "./web-server.js";
import { WebBridge, type BridgeSocket } from "./web-bridge.js";
import type { WorkerHost } from "./worker-host.js";
import type { WorkerRecoveryWarning } from "./worker-api-contract.js";

export interface WebBridgeHubOptions {
  /** The same loopback listener `host/web-server.ts` bound: an `upgrade`
   * handler attaches here rather than opening a second port. */
  readonly httpServer: Server;
  /** The one project `1667 web` opened. Every connection shares it — unlike
   * the removed desktop bridge, this hub owns no per-project registry. */
  readonly host: WorkerHost;
  /** The same per-run token and port `host/web-server.ts` checks. */
  readonly context: AuthorizationContext;
}

export interface WebBridgeHub {
  /** Publish a full recovery-warning snapshot to every open connection —
   * never a delta, so a tab that opened between two dismissals never has to
   * reconcile a partial view. */
  broadcastRecoveryWarnings(warnings: readonly WorkerRecoveryWarning[]): void;
  /** The server is stopping: close 1001 on every open connection (Bun does
   * not deliver that code to the client as-is — see `WsBridgeSocket.close` —
   * but the reason text still distinguishes it). The http server's own
   * `closeAllConnections` does not reach an already-upgraded socket, so the
   * hub destroys each one itself once its close frame has had a moment to
   * reach the client. */
  closeAll(): void;
}

/**
 * Accept WebSocket bridge connections on `WEB_BRIDGE_PATH`, over the loopback
 * HTTP server `1667 web` already started. Bun ships a builtin `ws` module
 * (verified against Bun 1.3.14): `noServer: true` plus this file's own
 * `upgrade` listener keeps every refusal — wrong path, wrong method, over
 * the connection cap, or a failed `authorizeRequest` — a bare
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

  options.httpServer.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
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
    if (!authorizeRequest(request, options.context, "websocket").ok) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      let bridge: WebBridge;
      bridge = new WebBridge(
        options.host,
        new WsBridgeSocket(ws, socket),
        () => { active.delete(bridge); },
        // A dismissal on this connection changes a snapshot every open
        // connection shares — broadcast it, not only this one's own view.
        () => { active.forEach((sibling) => sibling.publishRecoveryWarnings(options.host.recoveryWarnings)); }
      );
      active.add(bridge);
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
    broadcastRecoveryWarnings: (warnings) => {
      active.forEach((bridge) => bridge.publishRecoveryWarnings(warnings));
    },
    closeAll: () => {
      active.forEach((bridge) => bridge.close(1001, "1667 web is stopping"));
    }
  };
}

/** Adapt a `ws` `WebSocket` to the transport-agnostic `BridgeSocket` shape
 * `host/web-bridge.ts` expects, enforcing the two frame rules that
 * `WebBridge` itself never has to know about: text frames only (Bun's `ws`
 * shim has no framing opinion of its own to lean on here), and the size
 * bound `ws`'s `maxPayload` does not enforce under Bun (verified against
 * Bun 1.3.14). */
class WsBridgeSocket implements BridgeSocket {
  private messageListener: ((data: string) => void) | null = null;
  private closeListener: ((code: number, reason: string) => void) | null = null;

  constructor(
    private readonly ws: WebSocket,
    /** The raw socket `node:http`'s `upgrade` event handed `ws`. Bun's `ws`
     * shim does not reliably release this back to the http server on its
     * own — verified against Bun 1.3.14: without the direct `destroy()`
     * below, `server.close()`'s own connection draining and
     * `closeAllConnections()` both leave an already-upgraded socket open,
     * and `1667 web`'s process never exits after SIGINT while a bridge is
     * connected. `ws`'s own `terminate()` was not enough either — it did not
     * unblock `server.close()` in the same probe. */
    private readonly rawSocket: Duplex
  ) {
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
    }, 200);
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
