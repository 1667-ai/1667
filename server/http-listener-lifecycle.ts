import type { Server } from "node:http";
import { BACKEND_SHUTDOWN_GRACE_MS } from "../shared/types.js";
import type { HttpAuthRecordLease } from "./http-auth-record.js";
import type { HttpOperationSessionStore } from "./http-operation-sessions.js";
import type { RequestDrain } from "./request-drain.js";
import type { StoryService } from "./story-service.js";
import type { ProjectAuthority } from "./project-authority.js";

export type HttpCleanupFailure =
  | { readonly kind: "none" }
  | { readonly kind: "failure"; readonly error: unknown };

export interface HttpListenerShutdown {
  /** Failures known when the shutdown deadline settles. */
  readonly immediate: HttpCleanupFailure;
  /** Independent work still pending after the shutdown deadline. */
  readonly completions: readonly Promise<HttpCleanupFailure>[];
}

export interface HttpListenerResources {
  readonly server: Server;
  readonly requests: RequestDrain;
  service: StoryService | null;
  authLease: HttpAuthRecordLease | null;
  operationSessions: HttpOperationSessionStore | null;
  projectAuthority: ProjectAuthority | null;
}

/** One explicit lifecycle result for normal close, deadline, and late cleanup.
 * Reporter ownership can follow `completion` directly without inspecting an
 * exception graph for hidden control state. */
export async function shutDownHttpListener(
  resources: HttpListenerResources,
  graceMs = BACKEND_SHUTDOWN_GRACE_MS
): Promise<HttpListenerShutdown> {
  const synchronousFailures: unknown[] = [];
  captureSynchronousFailure(
    () => resources.requests.beginShutdown(),
    synchronousFailures
  );
  captureSynchronousFailure(
    () => resources.service?.cancelActive(),
    synchronousFailures
  );

  const serviceCompletion = cleanupOperation(async () => {
      await resources.requests.waitForIdle();
      await resources.service?.dispose();
  });
  const operations = [
    cleanupOperation(() => resources.operationSessions?.closeAll()),
    cleanupOperation(() => resources.authLease?.removeOwnRecord()),
    serviceCompletion,
    cleanupOperation(() => closeServer(resources.server)),
    serviceCompletion.then(async () =>
      await cleanupOperation(() => resources.projectAuthority?.release()))
  ];
  const settled: Array<HttpCleanupFailure | null> = operations.map(() => null);
  const completions = operations.map(async (operation, index) => {
    const result = await operation;
    settled[index] = result;
    return result;
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const completed = await Promise.race([
    Promise.all(completions).then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(
        () => resolve(false),
        graceMs
      );
    })
  ]);
  if (timer !== undefined) clearTimeout(timer);
  captureSynchronousFailure(
    () => resources.server.closeAllConnections(),
    synchronousFailures
  );

  if (completed) {
    return {
      immediate: cleanupFailure([
        ...synchronousFailures,
        ...settled.flatMap(failureEntries)
      ]),
      completions: []
    };
  }

  const knownFailures = [
    ...synchronousFailures,
    ...settled.flatMap(failureEntries)
  ];
  return {
    immediate: {
      kind: "failure",
      error: shutdownDeadlineFailure(knownFailures)
    },
    completions: completions.filter((_completion, index) =>
      settled[index] === null)
  };
}

function captureSynchronousFailure(
  operation: () => unknown,
  failures: unknown[]
): void {
  try {
    operation();
  } catch (error) {
    failures.push(error);
  }
}

async function cleanupOperation(
  operation: () => unknown | Promise<unknown>,
): Promise<HttpCleanupFailure> {
  try {
    await operation();
    return { kind: "none" };
  } catch (error) {
    return { kind: "failure", error };
  }
}

function failureEntries(
  failure: HttpCleanupFailure | null
): unknown[] {
  if (failure === null || failure.kind === "none") return [];
  return failure.error instanceof AggregateError
    ? failure.error.errors
    : [failure.error];
}

function cleanupFailure(
  failures: readonly unknown[]
): HttpCleanupFailure {
  if (failures.length === 0) return { kind: "none" };
  return {
    kind: "failure",
    error: failures.length === 1
      ? failures[0]
      : new AggregateError(
          failures,
          "Multiple 1667 HTTP shutdown operations failed"
        )
  };
}

function shutdownDeadlineFailure(
  knownFailures: readonly unknown[]
): Error {
  const deadline = new Error("1667 HTTP shutdown exceeded its deadline");
  if (knownFailures.length === 0) return deadline;
  return new AggregateError(
    [deadline, ...knownFailures],
    "1667 HTTP shutdown exceeded its deadline after cleanup failures",
    { cause: deadline }
  );
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}
