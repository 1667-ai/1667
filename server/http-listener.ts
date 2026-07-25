import { createServer, type Server } from "node:http";
import { BACKEND_SHUTDOWN_GRACE_MS } from "../shared/types.js";
import type { HttpAuthRecord } from "../shared/http-auth.js";
import {
  createHttpAuthRecord,
  type HttpAuthRecordLease,
  type HttpAuthRecordStoreOptions
} from "./http-auth-record.js";
import { validateDevelopmentOrigin } from "./http-cors.js";
import { resolveMachineTierRoot } from "./machine-tier.js";
import { toPublicServiceError } from "./errors.js";
import { sendJson } from "./http.js";
import { handleHttpRequest } from "./http-router.js";
import { RequestDrain } from "./request-drain.js";
import { StoryService } from "./story-service.js";
import type { HttpMutationGate } from "./http-router.js";
import {
  HttpOperationSessionStore,
  type HttpOperationSessionStoreOptions
} from "./http-operation-sessions.js";

interface HttpListenerCommonOptions {
  readonly port?: number;
  /** ADR007 machine tier. Defaults to the auth record's own state root. */
  readonly machineDir?: string;
  readonly developmentOrigin?: string | null;
  readonly authStore?: HttpAuthRecordStoreOptions;
  readonly mutationGate?: HttpMutationGate;
  readonly operationSessions?: HttpOperationSessionStoreOptions;
}

export type HttpListenerOptions = HttpListenerCommonOptions & (
  | {
      readonly dataDir?: string;
      readonly serviceFactory?: never;
    }
  | {
      readonly dataDir?: never;
      readonly serviceFactory: () => Promise<StoryService>;
    }
);

export interface HttpListener {
  readonly origin: string;
  readonly dataDir: string;
  readonly authRecord: HttpAuthRecord;
  close(): Promise<void>;
}

export async function startHttpListener(
  options: HttpListenerOptions = {}
): Promise<HttpListener> {
  const port = options.port ?? 7373;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error("1667 HTTP port must be between 0 and 65535");
  }
  const developmentOrigin = validateDevelopmentOrigin(options.developmentOrigin ?? null);
  const requests = new RequestDrain();
  let authLease: HttpAuthRecordLease | null = null;
  let operationSessions: HttpOperationSessionStore | null = null;
  let service: StoryService | null = null;
  let initializingService: StoryService | null = null;
  const server = createServer((request, response) => {
    const authRecord = authLease?.record;
    if (authRecord === undefined) {
      response.setHeader("connection", "close");
      return sendJson(response, 503, { error: "1667 listener is starting" });
    }
    void requests.run(() => handleHttpRequest({
      authRecord,
      developmentOrigin,
      service,
      operationSessions: operationSessions!,
      mutationGate: options.mutationGate
    }, request, response)).catch((error: unknown) => {
      if (response.headersSent) return void response.end();
      const known = toPublicServiceError(error);
      if (known.code === "internal") console.error(error);
      if (known.status === 401 || known.status === 403) {
        response.setHeader("connection", "close");
      }
      sendJson(response, known.status, { error: known.message, code: known.code });
    });
  });

  try {
    await listen(server, port);
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("1667 listener did not expose a TCP address");
    }
    const origin = address.port === 80
      ? "http://127.0.0.1"
      : `http://127.0.0.1:${address.port}`;
    authLease = await createHttpAuthRecord(origin, options.authStore);
    operationSessions = new HttpOperationSessionStore(
      authLease.record.instanceId,
      options.operationSessions
    );
    const machineDir = options.machineDir
      ?? options.authStore?.stateRoot
      ?? await resolveMachineTierRoot();
    initializingService = options.serviceFactory === undefined
      ? new StoryService({
          machineDir,
          ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir })
        })
      : await options.serviceFactory();
    await initializingService.init();
    service = initializingService;
    initializingService = null;
    let closing: Promise<void> | null = null;
    return {
      origin,
      dataDir: service.dataDir,
      authRecord: authLease.record,
      close: () => closing ??= closeListener(
        server,
        requests,
        service!,
        authLease!,
        operationSessions!
      )
    };
  } catch (error) {
    return await disposeFailedStart(
      server,
      requests,
      service ?? initializingService,
      authLease,
      error
    );
  }
}

async function closeListener(
  server: Server,
  requests: RequestDrain,
  service: StoryService,
  authLease: HttpAuthRecordLease,
  operationSessions: HttpOperationSessionStore
): Promise<void> {
  await Promise.all([
    operationSessions.closeAll(),
    shutDownListener(server, requests, service, authLease)
  ]);
}

async function shutDownListener(
  server: Server,
  requests: RequestDrain,
  service: StoryService | null,
  authLease: HttpAuthRecordLease | null
): Promise<void> {
  requests.beginShutdown();
  service?.cancelActive();
  const failures: unknown[] = [];
  let deadlineReached = false;
  const track = async (operation: Promise<unknown>): Promise<void> => {
    try {
      await operation;
    } catch (error) {
      failures.push(error);
      if (deadlineReached) {
        console.error("1667 HTTP cleanup failed after the shutdown deadline", error);
      }
    }
  };
  const shutdown = Promise.all([
    track(Promise.resolve(authLease?.removeOwnRecord())),
    track((async () => {
      await requests.waitForIdle();
      await service?.dispose();
    })()),
    track(closeServer(server))
  ]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const completed = await Promise.race([
      shutdown.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(
          () => resolve(false),
          BACKEND_SHUTDOWN_GRACE_MS
        );
      })
    ]);
    if (!completed) {
      deadlineReached = true;
      const deadlineError = new Error("1667 HTTP shutdown exceeded its deadline");
      if (failures.length > 0) {
        throw new AggregateError(
          [deadlineError, ...failures],
          "1667 HTTP shutdown exceeded its deadline after cleanup failures",
          { cause: deadlineError }
        );
      }
      throw deadlineError;
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        "Multiple 1667 HTTP shutdown operations failed"
      );
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    server.closeAllConnections();
  }
}

async function disposeFailedStart(
  server: Server,
  requests: RequestDrain,
  service: StoryService | null,
  authLease: HttpAuthRecordLease | null,
  startupError: unknown
): Promise<never> {
  try {
    await shutDownListener(server, requests, service, authLease);
  } catch (cleanupError) {
    const cleanupFailures = cleanupError instanceof AggregateError
      ? cleanupError.errors
      : [cleanupError];
    throw new AggregateError(
      [startupError, ...cleanupFailures],
      "1667 HTTP listener startup failed and cleanup also failed",
      { cause: startupError }
    );
  }
  throw startupError;
}

async function listen(server: Server, port: number): Promise<void> {
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

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}
