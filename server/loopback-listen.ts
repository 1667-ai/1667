import type { Server } from "node:http";

/**
 * Bind a server to `127.0.0.1`. A bind failure rejects with the raw
 * `listen` error — the caller classifies it (`EADDRINUSE`, `EACCES`, ...)
 * rather than inspecting server state after a resolve that never comes.
 *
 * Shared by `server/http-listener.ts` and `host/web-server.ts`, which each
 * bind a loopback-only `node:http` server the same way.
 */
export async function listenLoopback(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}
