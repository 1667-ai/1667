/**
 * Minimal ambient types for the one subset of the `ws` package
 * `host/web-bridge-server.ts` uses. No `@types/ws` is installed, and the
 * installed `ws` package ships no types of its own (verified: no `.d.ts`
 * anywhere under `node_modules/ws`) — that package sits in `node_modules`
 * only as another dependency's undeclared transitive dependency, which is
 * also why no root (Node) file may import "ws": that package could
 * disappear from the tree the moment its real owner's own dependency
 * changes. Bun ships a builtin `ws` module instead (verified against Bun
 * 1.3.14: `import { WebSocketServer } from "ws"` resolves with `noServer`
 * upgrade, `handleProtocols`, and clean close propagation, all with no
 * `node_modules/ws` present at all), so only `host/web-bridge-server.ts`,
 * which Bun always runs, may import this specifier — see
 * `test/frontend-import-boundary.test.ts`.
 */
declare module "ws" {
  import type { IncomingMessage } from "node:http";
  import type { Duplex } from "node:stream";

  export interface WebSocketServerOptions {
    readonly noServer?: boolean;
    /** Bun's shim also ignores `maxPayload` (verified against 1.3.14): the
     * bridge server checks every inbound frame's size itself. */
    readonly handleProtocols?: (
      protocols: Set<string>,
      request: IncomingMessage
    ) => string | false;
  }

  export class WebSocket {
    readonly protocol: string;
    readonly readyState: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    terminate(): void;
    on(event: "message", listener: (data: Buffer, isBinary: boolean) => void): this;
    on(event: "close", listener: (code: number, reason: Buffer) => void): this;
    on(event: "error", listener: (error: Error) => void): this;
  }

  export class WebSocketServer {
    constructor(options: WebSocketServerOptions);
    handleUpgrade(
      request: IncomingMessage,
      socket: Duplex,
      head: Buffer,
      callback: (ws: WebSocket, request: IncomingMessage) => void
    ): void;
    emit(event: "connection", ws: WebSocket, request: IncomingMessage): boolean;
    on(event: "connection", listener: (ws: WebSocket, request: IncomingMessage) => void): this;
  }
}
