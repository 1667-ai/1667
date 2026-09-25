import { expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { openWebBridgeTransport, type WebBridgeTransport } from "../../client/web-bridge-transport.js";
import { WEB_BRIDGE_PATH, WEB_BRIDGE_SUBPROTOCOL, type BridgeRecoveryWarning } from "../../shared/web-bridge-protocol.js";
import { createFailureEnvelope } from "../../shared/failure-envelope.js";
import { startWebBridgeServer } from "../../host/web-bridge-server.js";
import type { WebServer } from "../../host/web-server.js";
import type { WorkerHost } from "../../host/worker-host.js";
import type { WorkerTransport } from "../../host/worker-transport.js";
import type { WorkerRecoveryWarning } from "../../host/worker-api-contract.js";
import { WorkerApiError } from "../../host/worker-error.js";
import { createDurableMutationId } from "../../shared/durable-mutation-id.js";

/**
 * `host/web-bridge-server.ts`'s recovery-warning broadcast (review fix 1a),
 * at the hub level. A real startup recovery warning needs a crashed prior
 * run's durable outbox to replay against — impractical to arrange from an
 * external CLI spawn (`cli/test/web-bridge-e2e.test.ts`'s own level), so
 * this drives the hub directly instead, over a real `http.Server` and real
 * WebSocket connections (`openWebBridgeTransport`, exactly as a browser
 * tab would), against a faithful fake of `WorkerHost.transport` (a plain
 * object cannot structurally satisfy the concrete `WorkerTransport` class,
 * so it is cast) — two or more real components, matching CLAUDE.md's
 * integration-test definition.
 */

test("a dismissal's recovery-warning broadcast reaches every open connection; "
  + "an unchanged re-publish reaches none", async () => {
  // A real `dismissArchivedMutation` client message validates its mutation
  // id against the durable format (`shared/durable-mutation-id.ts`), so a
  // faithful fake warning needs one too, not an arbitrary string.
  const mutationIdA = createDurableMutationId();
  const mutationIdB = createDurableMutationId();
  const warningA = fakeRecoveryWarning(mutationIdA, "archived");
  const warningB = fakeRecoveryWarning(mutationIdB, "cleared");
  const host = fakeWorkerHost([warningA, warningB]);
  const { httpServer, port } = await listenLoopback();
  const webServer: WebServer = {
    url: `http://127.0.0.1:${port}/`,
    port,
    httpServer,
    // Auth is already covered end-to-end by web-bridge-e2e.test.ts; this
    // test is only about the recovery-warning broadcast fan-out.
    authorizeUpgrade: () => true,
    // Same generic backstop `host/web-server.ts`'s own `close` keeps: once a
    // connection has been upgraded, Bun's `node:http` server never invokes
    // `close`'s own callback at all (verified against Bun 1.3.14), even
    // after the hub above destroys every raw socket first.
    close: () => new Promise((resolve) => {
      httpServer.close(() => resolve());
      httpServer.closeAllConnections();
      setTimeout(resolve, 500);
    })
  };
  const hub = startWebBridgeServer({ webServer, host });
  try {
    const a = await connectBridge(port);
    const b = await connectBridge(port);
    try {
      expect(mutationIds(a.recoveryWarnings)).toEqual([mutationIdA, mutationIdB].sort());
      expect(mutationIds(b.recoveryWarnings)).toEqual([mutationIdA, mutationIdB].sort());

      // Nothing about the warning set changed since each connection's own
      // `hello`: `WorkerTransport`'s pre-mutation fence calls this on every
      // mutating call while any warning is outstanding, not only when the
      // set changes, so a repeat call here must reach neither connection.
      hub.broadcastRecoveryWarnings();
      hub.broadcastRecoveryWarnings();
      await settle();
      expect(a.warningsSeen).toHaveLength(0);
      expect(b.warningsSeen).toHaveLength(0);

      // A dismisses its own warning: both connections see the live,
      // deduplicated snapshot next — never a delta, and never just a's own view.
      await a.transport.dismissArchivedMutation(mutationIdA);
      await waitFor(() => b.warningsSeen.length > 0);
      expect(mutationIds(b.warningsSeen.at(-1)!)).toEqual([mutationIdB]);
      await waitFor(() => a.warningsSeen.length > 0);
      expect(mutationIds(a.warningsSeen.at(-1)!)).toEqual([mutationIdB]);
    } finally {
      a.transport.close();
      b.transport.close();
    }
  } finally {
    await hub.close();
    await webServer.close();
  }
}, 15_000);

function mutationIds(warnings: readonly BridgeRecoveryWarning[]): string[] {
  return warnings.map((warning) => warning.mutationId).sort();
}

function fakeRecoveryWarning(
  mutationId: string,
  resolution: "archived" | "cleared"
): WorkerRecoveryWarning {
  return {
    mutationId,
    method: "createStory",
    storyId: null,
    resolution,
    error: new WorkerApiError(createFailureEnvelope({
      code: "internal",
      message: "fake recovery warning",
      status: 500
    }))
  };
}

/** `WorkerHost.transport` is the concrete `WorkerTransport` class, which has
 * private fields no plain object can structurally satisfy — cast, matching
 * how a hub/bridge-level test is expected to fake it. Only the two members
 * `host/web-bridge.ts` actually calls are implemented; `call` is never
 * exercised here (this test sends no ordinary request). */
function fakeWorkerHost(initialWarnings: readonly WorkerRecoveryWarning[]): WorkerHost {
  let warnings = initialWarnings;
  const transport = {
    call: () => {
      throw new Error("fakeWorkerHost: call is not exercised by this test");
    },
    dismissArchivedMutation: async (mutationId: string) => {
      warnings = warnings.filter((warning) => warning.mutationId !== mutationId);
    }
  } as unknown as WorkerTransport;
  return {
    transport,
    recovery: Promise.resolve(initialWarnings),
    get recoveryWarnings() {
      return warnings;
    },
    failure: new Promise<Error>(() => {
      // Never settles: this fake host never fails.
    }),
    dispose: async () => undefined
  };
}

async function listenLoopback(): Promise<{ readonly httpServer: Server; readonly port: number }> {
  const httpServer = createServer();
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    throw new Error("test http server bound without a loopback network address");
  }
  return { httpServer, port: address.port };
}

async function connectBridge(port: number): Promise<{
  readonly transport: WebBridgeTransport;
  readonly recoveryWarnings: readonly BridgeRecoveryWarning[];
  readonly warningsSeen: (readonly BridgeRecoveryWarning[])[];
}> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${WEB_BRIDGE_PATH}`, [WEB_BRIDGE_SUBPROTOCOL]);
  const warningsSeen: (readonly BridgeRecoveryWarning[])[] = [];
  const { transport, recoveryWarnings } = await openWebBridgeTransport(socket, {
    onRecoveryWarnings: (warnings) => warningsSeen.push(warnings)
  });
  return { transport, recoveryWarnings, warningsSeen };
}

/** Lets any already-scheduled broadcast reach a connection's `onRecoveryWarnings`
 * before an assertion checks it did not. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition did not settle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
