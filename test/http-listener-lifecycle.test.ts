import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { shutDownHttpListener } from "../server/http-listener-lifecycle.js";
import type { HttpOperationSessionStore } from "../server/http-operation-sessions.js";
import { RequestDrain } from "../server/request-drain.js";
import type { StoryService } from "../server/story-service.js";

test("shutdown exposes independent failures behind a stalled cleanup", async () => {
  let rejectSessions!: (error: unknown) => void;
  const sessions = new Promise<void>((_resolve, reject) => {
    rejectSessions = reject;
  });
  const stalled = new Promise<void>(() => undefined);
  const shutdown = await shutDownHttpListener({
    server: createServer(),
    requests: new RequestDrain(),
    service: {
      cancelActive: () => undefined,
      dispose: async () => await stalled
    } as unknown as StoryService,
    authLease: null,
    operationSessions: {
      closeAll: async () => await sessions
    } as unknown as HttpOperationSessionStore,
    projectAuthority: null
  }, 5);
  assert.equal(shutdown.immediate.kind, "failure");
  assert.ok(shutdown.completions.length >= 2);

  rejectSessions(new Error("late operation-session cleanup failed"));
  const outcomes: unknown[] = [];
  for (const completion of shutdown.completions) {
    void completion.then((outcome) => {
      if (outcome.kind === "failure") outcomes.push(outcome.error);
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(outcomes.some((error) =>
    error instanceof Error
    && error.message === "late operation-session cleanup failed"));
});
