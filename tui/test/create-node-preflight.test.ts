/**
 * createNode version-preflight failures are adapter-owned and definitely
 * unsent. No node mutation, mutation id, or createNode worker post leaves
 * the client when expectedVersion fails on a cold cache.
 *
 * Explicit-unsent is orthogonal to connection class: application ApiError
 * stays online; transport/plain Error marks the connection down.
 */
import { afterEach, expect, test } from "bun:test";
import { createFailureEnvelope } from "../../shared/failure-envelope.js";
import {
  ApiError,
  ApiRecoveryRequiredError,
  isExplicitMutationUnsent
} from "../src/api.js";
import { isDefinitePlacementFailure } from "../src/aside-placement.js";
import { createConnectionMonitor } from "../src/connection.js";
import { demoAppSource } from "../src/demo.js";
import { WorkerApiError } from "../src/worker-error.js";
import { storyApiFromWorkerTransport } from "../src/worker-story-api.js";
import {
  createTestApi as createApi,
  testHttpMetadata as metadata,
  testStoryPayload as storyPayload
} from "./http-api-fixture.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

test("HTTP createNode cold version preflight failure is explicit-unsent and posts no node mutation", async () => {
  const paths: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    paths.push(`${init?.method ?? "GET"} ${path}`);
    if (path === "/api/health") return Response.json(metadata());
    if (path === "/api/stories/story") {
      return Response.json(
        createFailureEnvelope({
          code: "not_found",
          message: "version preflight load failed",
          status: 404
        }),
        { status: 404 }
      );
    }
    throw new Error(`Unexpected API path: ${path}`);
  }) as typeof fetch;

  const api = createApi("http://127.0.0.1:7373");
  const error = await rejection(api.createNode("story", {
    parentId: null,
    text: "must not post"
  }));

  expect(isExplicitMutationUnsent(error)).toBeTrue();
  expect(error instanceof ApiRecoveryRequiredError).toBeTrue();
  expect((error as Error).message).toContain("createNode was not sent");
  expect((error as Error).message).toContain("version preflight load failed");
  expect(isDefinitePlacementFailure(error)).toBeTrue();
  expect(paths.some((entry) => entry.includes("/nodes"))).toBeFalse();
  expect(paths).toContain("GET /api/stories/story");
});

test("HTTP cold preflight application failure stays online, unsent, and posts no nodes", async () => {
  const paths: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    paths.push(`${init?.method ?? "GET"} ${path}`);
    if (path === "/api/health") return Response.json(metadata());
    if (path === "/api/stories/story") {
      return Response.json(
        createFailureEnvelope({
          code: "not_found",
          message: "story missing for version preflight",
          status: 404
        }),
        { status: 404 }
      );
    }
    throw new Error(`Unexpected API path: ${path}`);
  }) as typeof fetch;

  const monitor = createConnectionMonitor(createApi("http://127.0.0.1:7373"));
  const error = await rejection(monitor.api.createNode("story", {
    parentId: null,
    text: "must not post"
  }));

  expect(isExplicitMutationUnsent(error)).toBeTrue();
  expect(error instanceof ApiError).toBeTrue();
  expect(isDefinitePlacementFailure(error)).toBeTrue();
  expect(monitor.state().down).toBeFalse();
  expect(paths.some((entry) => entry.includes("/nodes"))).toBeFalse();
});

test("HTTP cold preflight transport failure goes down, unsent, and posts no nodes", async () => {
  const paths: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    paths.push(`${init?.method ?? "GET"} ${path}`);
    if (path === "/api/health") return Response.json(metadata());
    if (path === "/api/stories/story") {
      throw new TypeError("fetch failed: connection refused");
    }
    throw new Error(`Unexpected API path: ${path}`);
  }) as typeof fetch;

  const monitor = createConnectionMonitor(createApi("http://127.0.0.1:7373"));
  const error = await rejection(monitor.api.createNode("story", {
    parentId: null,
    text: "must not post"
  }));

  expect(isExplicitMutationUnsent(error)).toBeTrue();
  expect(error instanceof ApiError).toBeFalse();
  expect((error as Error).message).toContain("createNode was not sent");
  expect((error as Error).message).toContain("connection refused");
  expect((error as Error).cause instanceof TypeError).toBeTrue();
  expect(isDefinitePlacementFailure(error)).toBeTrue();
  expect(monitor.state().down).toBeTrue();
  expect(paths.some((entry) => entry.includes("/nodes"))).toBeFalse();
  expect(paths).toContain("GET /api/stories/story");
});

test("HTTP createNode still mutates after a successful cold version preflight", async () => {
  const paths: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    paths.push(`${init?.method ?? "GET"} ${path}`);
    if (path === "/api/health") return Response.json(metadata());
    // Empty path/nodes is a valid cold story for version metadata only.
    if (path === "/api/stories/story" || path === "/api/stories/story/nodes") {
      return Response.json(storyPayload("story"));
    }
    throw new Error(`Unexpected API path: ${path}`);
  }) as typeof fetch;

  const api = createApi("http://127.0.0.1:7373");
  const payload = await api.createNode("story", {
    parentId: null,
    text: "placed"
  });

  expect(payload.id).toBe("story");
  expect(paths).toContain("GET /api/stories/story");
  expect(paths).toContain("POST /api/stories/story/nodes");
});

test("embedded createNode cold loadStory preflight failure is explicit-unsent and posts no createNode", async () => {
  const methods: string[] = [];
  const api = storyApiFromWorkerTransport({
    call: async (method: string) => {
      methods.push(method);
      if (method === "loadStory") {
        throw new WorkerApiError(createFailureEnvelope({
          code: "not_found",
          message: "loadStory preflight failed",
          status: 404
        }));
      }
      throw new Error(`Unexpected method: ${method}`);
    }
  } as never);

  const error = await rejection(api.createNode("story", {
    parentId: null,
    text: "must not create"
  }));

  expect(isExplicitMutationUnsent(error)).toBeTrue();
  expect(error instanceof ApiRecoveryRequiredError).toBeTrue();
  expect((error as Error).message).toContain("createNode was not sent");
  expect((error as Error).message).toContain("loadStory preflight failed");
  expect(isDefinitePlacementFailure(error)).toBeTrue();
  expect(methods).toEqual(["loadStory"]);
});

test("embedded createNode cold preflight transport failure is unsent and not ApiError", async () => {
  const methods: string[] = [];
  const api = storyApiFromWorkerTransport({
    call: async (method: string) => {
      methods.push(method);
      if (method === "loadStory") {
        throw new Error("Embedded backend is not running");
      }
      throw new Error(`Unexpected method: ${method}`);
    }
  } as never);

  const error = await rejection(api.createNode("story", {
    parentId: null,
    text: "must not create"
  }));

  expect(isExplicitMutationUnsent(error)).toBeTrue();
  expect(error instanceof ApiError).toBeFalse();
  expect(isDefinitePlacementFailure(error)).toBeTrue();
  expect(methods).toEqual(["loadStory"]);
});

test("embedded createNode after a warm version cache posts createNode only", async () => {
  const methods: string[] = [];
  const source = demoAppSource();
  const versioned = {
    ...structuredClone(source.payload),
    id: "story",
    aggregateVersion: {
      kind: "v6" as const,
      revision: "00000000000000000001" as const
    }
  };
  const api = storyApiFromWorkerTransport({
    call: async (method: string) => {
      methods.push(method);
      if (method === "loadStory") return versioned;
      if (method === "createNode") return versioned;
      throw new Error(`Unexpected method: ${method}`);
    }
  } as never);

  await api.loadStory("story");
  methods.length = 0;
  await api.createNode("story", { parentId: null, text: "ok" });

  expect(methods).toEqual(["createNode"]);
});
