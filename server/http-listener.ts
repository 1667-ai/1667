import { createServer, type Server } from "node:http";
import type { HttpAuthRecord } from "../shared/http-auth.js";
import {
  createHttpAuthRecord,
  type HttpAuthRecordStoreOptions
} from "./http-auth-record.js";
import { validateDevelopmentOrigin } from "./http-cors.js";
import { resolveDiagnosticMachineTier } from "./diagnostic-machine-tier.js";
import { sendJson } from "./http.js";
import { handleHttpRequest } from "./http-router.js";
import { RequestDrain } from "./request-drain.js";
import { StoryService } from "./story-service.js";
import type { HttpMutationGate } from "./http-router.js";
import {
  HttpOperationSessionStore,
  type HttpOperationSessionStoreOptions
} from "./http-operation-sessions.js";
import {
  InternalErrorReporter,
  type InternalErrorReporterLease
} from "./internal-error-reporter.js";
import {
  PublicRuntimeError
} from "./errors.js";
import type { ProjectAuthority } from "./project-authority.js";
import { executeHttpRequest } from "./http-request-lifecycle.js";
import {
  HttpListenerCloser
} from "./http-listener-close.js";
import type {
  HttpListenerResources
} from "./http-listener-lifecycle.js";
import { HttpReadiness } from "./http-readiness.js";

interface HttpRequestContext {
  readonly authRecord: HttpAuthRecord;
  readonly errorReporter: InternalErrorReporter;
  readonly operationSessions: HttpOperationSessionStore;
  readonly service: StoryService | null;
}

interface HttpReadyContext extends HttpRequestContext {
  readonly service: StoryService;
  readonly projectAuthority: ProjectAuthority;
}

interface HttpListenerCommonOptions {
  readonly port?: number;
  /** ADR007 machine tier. Defaults to the auth record's own state root. */
  readonly machineDir?: string;
  readonly developmentOrigin?: string | null;
  /** Also emit full unexpected-error diagnostics to stderr. */
  readonly printLogs?: boolean;
  readonly authStore?: HttpAuthRecordStoreOptions;
  readonly mutationGate?: HttpMutationGate;
  readonly operationSessions?: HttpOperationSessionStoreOptions;
  /** Transfers reporter ownership when startup accepts the machine tier. */
  readonly errorReporterLease?: InternalErrorReporterLease;
  /** External project authority transferred to the listener lifecycle. */
  readonly projectAuthority?: ProjectAuthority;
}

export type HttpListenerOptions = HttpListenerCommonOptions & (
  | {
      readonly dataDir?: string;
      readonly serviceFactory?: never;
    }
  | {
      readonly dataDir?: never;
      readonly serviceFactory: (
        errorReporter: InternalErrorReporter,
        machineDir: string
      ) => Promise<StoryService>;
    }
);

export interface HttpListener {
  readonly origin: string;
  readonly dataDir: string;
  readonly authRecord: HttpAuthRecord;
  announceProjectServer(signal?: AbortSignal): Promise<void>;
  trackReadiness(readiness: Promise<void>, signal: AbortSignal): void;
  close(
    failure?: HttpListenerFailure
  ): Promise<void>;
}

export interface HttpListenerFailure {
  readonly error: unknown;
  readonly operation: string;
}

export async function startHttpListener(
  options: HttpListenerOptions = {}
): Promise<HttpListener> {
  // ADR007: nothing owns a fixed port. Zero asks the kernel for a free one and
  // the project's run record publishes whatever it gave us.
  const port = options.port ?? 0;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new PublicRuntimeError(
      "1667 HTTP port must be between 0 and 65535"
    );
  }
  let developmentOrigin: string | null;
  let machineDir: string;
  try {
    developmentOrigin = validateDevelopmentOrigin(
      options.developmentOrigin ?? null
    );
  } catch (error) {
    throw publicStartupFailure(error);
  }
  machineDir = await resolveDiagnosticMachineTier(
    options.machineDir ?? options.authStore?.stateRoot,
    {
      service: "http-server-startup",
      operation: "machine-tier-resolution"
    },
    { print: options.printLogs === true }
  );
  const requests = new RequestDrain();
  let requestContext: HttpRequestContext | null = null;
  const server = createServer((request, response) => {
    const context = requestContext;
    if (context === null) {
      response.setHeader("connection", "close");
      return sendJson(response, 503, { error: "1667 listener is starting" });
    }
    void executeHttpRequest({
      requests,
      errorReporter: context.errorReporter,
      request,
      response,
      handle: async () => {
        await handleHttpRequest({
          authRecord: context.authRecord,
          developmentOrigin,
          service: context.service,
          errorReporter: context.errorReporter,
          operationSessions: context.operationSessions,
          mutationGate: options.mutationGate
        }, request, response);
      }
    });
  });
  const errorReporter = options.errorReporterLease?.transfer()
    ?? await InternalErrorReporter.open(machineDir, {
      print: options.printLogs === true
    });
  const resources: HttpListenerResources = {
    server,
    requests,
    service: null,
    authLease: null,
    operationSessions: null,
    projectAuthority: options.projectAuthority ?? null
  };
  const readiness = new HttpReadiness();
  const closer = new HttpListenerCloser(
    resources,
    readiness,
    errorReporter,
    async () => await InternalErrorReporter.open(machineDir, {
      print: options.printLogs === true
    })
  );

  try {
    try {
      await listen(server, port);
    } catch (error) {
      throw publicBindFailure(error);
    }
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("1667 listener did not expose a TCP address");
    }
    const origin = address.port === 80
      ? "http://127.0.0.1"
      : `http://127.0.0.1:${address.port}`;
    const authStore = options.authStore?.stateRoot === undefined
      && options.authStore?.platformState === undefined
      ? { ...options.authStore, stateRoot: machineDir }
      : options.authStore;
    const authLease = await createHttpAuthRecord(origin, authStore);
    resources.authLease = authLease;
    const operationSessions = new HttpOperationSessionStore(
      authLease.record.instanceId,
      options.operationSessions
    );
    resources.operationSessions = operationSessions;
    requestContext = Object.freeze({
      authRecord: authLease.record,
      errorReporter,
      operationSessions,
      service: null
    });
    const service = options.serviceFactory === undefined
      ? new StoryService({
          machineDir,
          errorReporter,
          ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir })
        })
      : await options.serviceFactory(errorReporter, machineDir);
    resources.service = service;
    await service.init();
    const listenerProjectAuthority = options.projectAuthority
      ?? borrowedServiceAuthority(service);
    resources.projectAuthority = listenerProjectAuthority;
    const context: HttpReadyContext = Object.freeze({
      authRecord: authLease.record,
      errorReporter,
      operationSessions,
      service,
      projectAuthority: listenerProjectAuthority
    });
    requestContext = context;
    const listener: HttpListener = {
      origin,
      dataDir: context.service.dataDir,
      authRecord: context.authRecord,
      announceProjectServer: async (signal) => {
        await context.projectAuthority.announceProjectServer({
          port: address.port,
          url: origin
        }, signal);
      },
      trackReadiness: (publication, signal) => {
        readiness.track(publication, signal);
      },
      close: async (failure) => {
        const result = await closer.close(failure === undefined
          ? undefined
          : { ...failure, phase: "process" });
        if (result.kind === "failure") throw result.error;
      }
    };
    return listener;
  } catch (error) {
    const result = await closer.close({
      error,
      operation: "startup",
      phase: "startup"
    });
    if (result.kind === "failure") throw result.error;
    throw error;
  }
}

function borrowedServiceAuthority(
  service: StoryService
): ProjectAuthority {
  return {
    announceProjectServer: async (server, signal) => {
      await service.announceProjectServer(server, signal);
    },
    // StoryService.dispose() releases its service-owned authority first.
    release: async () => undefined
  };
}

function publicBindFailure(error: unknown): unknown {
  if (error instanceof Error
    && "code" in error
    && (error.code === "EADDRINUSE" || error.code === "EACCES")) {
    return new PublicRuntimeError(error.message);
  }
  return error;
}

function publicStartupFailure(error: unknown): PublicRuntimeError {
  if (error instanceof PublicRuntimeError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new PublicRuntimeError(
    message.trim().length > 0
      ? message
      : "1667 backend startup configuration is invalid"
  );
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
