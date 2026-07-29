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
import {
  readHttpDataDirectoryIdentity,
  type HttpDataDirectoryIdentity
} from "./data-directory-id.js";
import { resolveDataDirectory } from "./data-directory.js";
import { assertHttpPlatformSupport } from "./http-platform-support.js";
import { resolveMachineTierRootPath } from "./machine-tier.js";
import {
  assertMachineTierOutsideDirectory,
  assertPathInsideDirectory,
  resolveProspectiveCanonicalPath
} from "./machine-tier-boundary.js";
import { retainHttpProject } from "./http-project-authority.js";

interface HttpRequestContext {
  readonly authRecord: HttpAuthRecord;
  readonly dataDirectoryIdentity: HttpDataDirectoryIdentity | null;
  readonly errorReporter: InternalErrorReporter;
  readonly operationSessions: HttpOperationSessionStore;
  readonly service: StoryService | null;
}

interface HttpReadyContext extends HttpRequestContext {
  readonly dataDirectoryIdentity: HttpDataDirectoryIdentity;
  readonly service: StoryService;
  readonly projectAuthority: ProjectAuthority;
}

interface HttpListenerAuthStoreOptions
extends Omit<HttpAuthRecordStoreOptions, "platformState"> {
  readonly platformState?: never;
}

export interface HttpListenerProject {
  /** The project authority root. The factory receives a retained path. */
  readonly root: string;
  /** The data authority. The factory receives a retained path. */
  readonly dataDir: string;
}

interface HttpListenerCommonOptions {
  readonly port?: number;
  /** The machine tier. Defaults to the auth record's own state root. */
  readonly machineDir?: string;
  readonly developmentOrigin?: string | null;
  /** Also emit full unexpected-error diagnostics to stderr. */
  readonly printLogs?: boolean;
  readonly authStore?: HttpListenerAuthStoreOptions;
  readonly mutationGate?: HttpMutationGate;
  readonly operationSessions?: HttpOperationSessionStoreOptions;
  /** Transfers reporter ownership when startup accepts the machine tier. */
  readonly errorReporterLease?: InternalErrorReporterLease;
  /** External project authority transferred to the listener lifecycle. */
  readonly projectAuthority?: ProjectAuthority;
  /** Test hook for the shared shutdown deadline. */
  readonly shutdownGraceMs?: number;
}

export type HttpListenerOptions = HttpListenerCommonOptions & (
  | {
      readonly dataDir?: string;
      readonly project?: never;
      readonly serviceFactory?: never;
    }
  | {
      readonly dataDir?: never;
      readonly project: HttpListenerProject;
      readonly serviceFactory: (
        errorReporter: InternalErrorReporter,
        machineDir: string,
        project: HttpListenerProject
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
  // Nothing owns a fixed port. Zero asks the kernel for a free one and
  // the project's run record publishes whatever it gave us.
  const port = options.port ?? 0;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new PublicRuntimeError(
      "1667 HTTP port must be between 0 and 65535"
    );
  }
  assertHttpPlatformSupport();
  const selectedProject: HttpListenerProject =
    options.serviceFactory === undefined
      ? projectForDirectListener(options.dataDir ?? resolveDataDirectory())
      : Object.freeze({ ...options.project });
  await assertPathInsideDirectory(
    selectedProject.root,
    selectedProject.dataDir,
    "HTTP project data directory must be inside its project"
  );
  let developmentOrigin: string | null;
  let machineDir: string;
  try {
    developmentOrigin = validateDevelopmentOrigin(
      options.developmentOrigin ?? null
    );
  } catch (error) {
    throw publicStartupFailure(error);
  }
  const machineTierContext = {
    service: "http-server-startup",
    operation: "machine-tier-resolution"
  } as const;
  const configuredMachineDir =
    options.machineDir ?? options.authStore?.stateRoot;
  const prospectiveMachineDir = configuredMachineDir
    ?? await resolveDiagnosticMachineTier(
      undefined,
      machineTierContext,
      {
        print: options.printLogs === true,
        resolve: resolveMachineTierRootPath
      }
    );
  await assertMachineTierOutsideDirectory(
    selectedProject.root,
    prospectiveMachineDir,
    "HTTP server mode requires the machine tier outside the project"
  );
  machineDir = await resolveDiagnosticMachineTier(
    configuredMachineDir,
    machineTierContext,
    { print: options.printLogs === true }
  );
  await assertMachineTierOutsideDirectory(
    selectedProject.root,
    machineDir,
    "HTTP server mode requires the machine tier outside the project"
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
          dataDirectoryIdentity: context.dataDirectoryIdentity,
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
    }),
    options.shutdownGraceMs
  );
  let startupProjectAuthority: Awaited<
    ReturnType<typeof retainHttpProject>
  > | null = null;

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
    const retainedProject = await retainHttpProject(
      selectedProject,
      machineDir
    );
    startupProjectAuthority = retainedProject;
    const service = options.serviceFactory === undefined
      ? new StoryService({
          machineDir,
          errorReporter,
          dataDir: retainedProject.authority.dataDir
        })
      : await options.serviceFactory(
          errorReporter,
          machineDir,
          retainedProject.authority
        );
    resources.service = service;
    await assertServiceProject(service, retainedProject.authority);
    const authStore: HttpAuthRecordStoreOptions = {
      ...options.authStore,
      stateRoot: machineDir
    };
    const authLease = await createHttpAuthRecord(origin, authStore);
    resources.authLease = authLease;
    const operationSessions = new HttpOperationSessionStore(
      authLease.record.instanceId,
      options.operationSessions
    );
    resources.operationSessions = operationSessions;
    requestContext = Object.freeze({
      authRecord: authLease.record,
      dataDirectoryIdentity: null,
      errorReporter,
      operationSessions,
      service: null
    });
    await service.init();
    await retainedProject.release();
    startupProjectAuthority = null;
    const dataDirectoryIdentity =
      service.retainedHttpDataDirectoryIdentity
      ?? await readHttpDataDirectoryIdentity(
        service.dataDirectoryAuthorityPath,
        machineDir
      );
    const listenerProjectAuthority = options.projectAuthority
      ?? borrowedServiceAuthority(service);
    resources.projectAuthority = listenerProjectAuthority;
    const context: HttpReadyContext = Object.freeze({
      authRecord: authLease.record,
      dataDirectoryIdentity,
      errorReporter,
      operationSessions,
      service,
      projectAuthority: listenerProjectAuthority
    });
    requestContext = context;
    const listener: HttpListener = {
      origin,
      dataDir: retainedProject.canonical.dataDir,
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
    let startupError = error;
    try {
      await startupProjectAuthority?.release();
    } catch (releaseError) {
      startupError = new AggregateError(
        [error, releaseError],
        "1667 HTTP startup and project-authority release failed",
        { cause: error }
      );
    }
    startupProjectAuthority = null;
    const result = await closer.close({
      error: startupError,
      operation: "startup",
      phase: "startup"
    });
    if (result.kind === "failure") throw result.error;
    throw startupError;
  }
}

function projectForDirectListener(dataDir: string): HttpListenerProject {
  return Object.freeze({ root: dataDir, dataDir });
}

async function assertServiceProject(
  service: StoryService,
  project: HttpListenerProject
): Promise<void> {
  const [selectedDataDir, serviceDataDir] = await Promise.all([
    resolveProspectiveCanonicalPath(project.dataDir),
    resolveProspectiveCanonicalPath(service.dataDir)
  ]);
  if (selectedDataDir !== serviceDataDir) {
    throw new Error(
      "HTTP service data directory does not match its selected project"
    );
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
