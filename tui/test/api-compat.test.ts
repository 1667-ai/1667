import { afterEach, expect, test } from "bun:test";
import {
  HTTP_API_PROTOCOL_VERSION,
  HTTP_CLIENT_PROTOCOL_HEADER,
  HTTP_SERVER_INSTANCE_HEADER
} from "../../shared/http-protocol.js";
import {
  ApiHttpError,
  HTTP_GENERATION_REQUEST_TIMEOUT_MS,
  createApi as createHttpApi
} from "../src/api.js";
import { createConnectionMonitor } from "../src/connection.js";
import {
  createTestApi as createApi,
  testHttpAccess,
  testHttpMetadata as metadata,
  testStoryPayload as storyPayload
} from "./http-api-fixture.js";
import {
  MemoryHttpMutationIntentStore
} from "../src/http-mutation-intents.js";
import { DEMO_SETTINGS_DOCUMENT, DEMO_SETTINGS_VIEW } from "../src/demo.js";
import { HTTP_AUTHORIZATION_HEADER } from "../../shared/http-auth.js";
import {
  HTTP_OPERATION_LIFETIME_MS,
  HTTP_OPERATION_TICKET_HEADER
} from "../../shared/http-operation-protocol.js";
import {
  WORKER_PROVIDER_CHECK_TIMEOUT_MS
} from "../../shared/worker-protocol.js";
import {
  HttpListenerAuthority
} from "../../shared/http-listener-authority.js";
import { decodeMarkdownHttpBody } from "../../shared/import-markdown-wire.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("HTTP StoryApi rejects non-loopback and credential-bearing URLs before fetch", () => {
  expect(() => createApi("https://example.com")).toThrow("canonical numeric loopback");
  expect(() => createApi("http://user:secret@127.0.0.1:7373")).toThrow("canonical numeric loopback");
  expect(() => createApi("http://127.0.0.1:7373/prefix")).toThrow("canonical numeric loopback");
});

test("HTTP StoryApi preflights before every data request", async () => {
  const calls: string[] = [];
  const healthHeaders: Headers[] = [];
  const dataHeaders: Headers[] = [];
  globalThis.fetch = (async (input, init) => {
    calls.push(String(input));
    if (calls.length % 2 === 1) {
      healthHeaders.push(new Headers(init?.headers));
      return Response.json(metadata());
    }
    dataHeaders.push(new Headers(init?.headers));
    return Response.json(catalogPage());
  }) as typeof fetch;
  const api = createApi("http://127.0.0.1:7373");

  expect(await api.listStories()).toEqual([]);
  expect(await api.listStories()).toEqual([]);
  expect(calls).toEqual([
    "http://127.0.0.1:7373/api/health",
    "http://127.0.0.1:7373/api/stories/catalog-page",
    "http://127.0.0.1:7373/api/health",
    "http://127.0.0.1:7373/api/stories/catalog-page"
  ]);
  expect(healthHeaders.map((headers) =>
    headers.get(HTTP_AUTHORIZATION_HEADER))).toEqual([
    `Bearer ${"11".repeat(32)}`,
    `Bearer ${"11".repeat(32)}`
  ]);
  expect(healthHeaders.map((headers) =>
    headers.get(HTTP_CLIENT_PROTOCOL_HEADER))).toEqual([
    String(HTTP_API_PROTOCOL_VERSION),
    String(HTTP_API_PROTOCOL_VERSION)
  ]);
  expect(healthHeaders.map((headers) =>
    headers.get(HTTP_SERVER_INSTANCE_HEADER))).toEqual([
    metadata().serverInstanceId,
    metadata().serverInstanceId
  ]);
  expect(dataHeaders.map((headers) => headers.get(HTTP_CLIENT_PROTOCOL_HEADER))).toEqual([
    String(HTTP_API_PROTOCOL_VERSION),
    String(HTTP_API_PROTOCOL_VERSION)
  ]);
  expect(dataHeaders.map((headers) => headers.get(HTTP_SERVER_INSTANCE_HEADER))).toEqual([
    metadata().serverInstanceId,
    metadata().serverInstanceId
  ]);
  expect(dataHeaders.map((headers) => headers.get(HTTP_AUTHORIZATION_HEADER))).toEqual([
    `Bearer ${"bb".repeat(32)}`,
    `Bearer ${"bb".repeat(32)}`
  ]);
});

test("HTTP StoryApi reuses one durable mutation after response loss", async () => {
  const mutationIds: unknown[] = [];
  let endpointCalls = 0;
  let committed = 0;
  const result = storyPayload("one");
  globalThis.fetch = (async (input) => {
    if (String(input).endsWith("/api/health")) return Response.json(metadata());
    endpointCalls += 1;
    if (endpointCalls === 1) {
      committed += 1;
      throw new TypeError("socket closed after commit");
    }
    return Response.json(result);
  }) as typeof fetch;
  const api = createApi(
    "http://127.0.0.1:7373",
    undefined,
    (reservation) => mutationIds.push(reservation.mutationId)
  );

  expect((await api.createStory("one")).id).toBe("one");
  expect(committed).toBe(1);
  expect(endpointCalls).toBe(2);
  expect(mutationIds).toHaveLength(2);
  expect(typeof mutationIds[0]).toBe("string");
  expect(mutationIds[1]).toBe(mutationIds[0]);
  expect(mutationIds).not.toContain(undefined);
});

test("HTTP StoryApi retains create identity after transport retry exhaustion", async () => {
  const mutationIds: unknown[] = [];
  let endpointCalls = 0;
  globalThis.fetch = (async (input) => {
    if (String(input).endsWith("/api/health")) {
      return Response.json(metadata());
    }
    endpointCalls += 1;
    if (endpointCalls <= 2) {
      throw new TypeError("listener disappeared after possible commit");
    }
    return Response.json(storyPayload("retained"));
  }) as typeof fetch;
  const api = createApi(
    "http://127.0.0.1:7373",
    undefined,
    (reservation) => mutationIds.push(reservation.mutationId)
  );

  expect(
    await rejection(api.createStory("retained")) instanceof TypeError
  ).toBe(true);
  expect((await api.createStory("retained")).id).toBe("retained");
  expect(mutationIds).toHaveLength(3);
  expect(new Set(mutationIds).size).toBe(1);
});

test("admission refusal preserves a retained create identity", async () => {
  const mutationIds: unknown[] = [];
  let endpointCalls = 0;
  let refuseAdmission = false;
  globalThis.fetch = (async (input) => {
    if (String(input).endsWith("/api/health")) {
      return Response.json(metadata());
    }
    endpointCalls += 1;
    if (endpointCalls <= 2) {
      throw new TypeError("listener disappeared after possible commit");
    }
    return Response.json(storyPayload("retained"));
  }) as typeof fetch;
  const api = createApi(
    "http://127.0.0.1:7373",
    undefined,
    (reservation) => {
      mutationIds.push(reservation.mutationId);
      if (refuseAdmission) {
        return Response.json(
          { error: "Operation capacity is full", code: "resource_busy" },
          { status: 429 }
        );
      }
    }
  );

  expect(
    await rejection(api.createStory("retained")) instanceof TypeError
  ).toBe(true);
  refuseAdmission = true;
  const admission = await rejection(api.createStory("retained"));
  expect(admission instanceof ApiHttpError).toBe(true);
  expect((admission as ApiHttpError).requestSent).toBe(false);
  refuseAdmission = false;
  expect((await api.createStory("retained")).id).toBe("retained");
  expect(endpointCalls).toBe(3);
  expect(new Set(mutationIds).size).toBe(1);
});

test("recovery-required retry preserves a retained create identity", async () => {
  const mutationIds: unknown[] = [];
  let endpointCalls = 0;
  let reportRecovered = false;
  globalThis.fetch = (async (input) => {
    if (String(input).endsWith("/api/health")) {
      return Response.json(metadata());
    }
    endpointCalls += 1;
    if (endpointCalls <= 2) {
      throw new TypeError("listener disappeared after possible commit");
    }
    return Response.json(storyPayload("retained"));
  }) as typeof fetch;
  const api = createApi(
    "http://127.0.0.1:7373",
    () => {
      const recovered = reportRecovered;
      reportRecovered = false;
      return recovered;
    },
    (reservation) => mutationIds.push(reservation.mutationId)
  );

  expect(
    await rejection(api.createStory("retained")) instanceof TypeError
  ).toBe(true);
  reportRecovered = true;
  expect(
    (await rejection(api.createStory("retained")) as Error).message
  ).toContain("operation was not sent");
  expect((await api.createStory("retained")).id).toBe("retained");
  expect(endpointCalls).toBe(3);
  expect(new Set(mutationIds).size).toBe(1);
});

test("concurrent create response loss retains the shared mutation identity", async () => {
  const mutationIds: unknown[] = [];
  let endpointCalls = 0;
  let secondEndpointStarted!: () => void;
  const secondEndpoint = new Promise<void>((resolve) => {
    secondEndpointStarted = resolve;
  });
  let confirmedSettlement!: () => void;
  const confirmed = new Promise<void>((resolve) => {
    confirmedSettlement = resolve;
  });
  globalThis.fetch = (async (input) => {
    if (String(input).endsWith("/api/health")) {
      return Response.json(metadata());
    }
    endpointCalls += 1;
    if (endpointCalls === 1) {
      await secondEndpoint;
      return Response.json(storyPayload("shared"));
    }
    if (endpointCalls === 2) {
      secondEndpointStarted();
      throw new TypeError("concurrent response lost");
    }
    if (endpointCalls === 3) {
      await confirmed;
      throw new TypeError("concurrent retry response lost");
    }
    return Response.json(storyPayload("shared"));
  }) as typeof fetch;
  const memory = new MemoryHttpMutationIntentStore();
  const baseUrl = "http://127.0.0.1:7373";
  const api = createHttpApi(baseUrl, undefined, {
    ...testHttpAccess(baseUrl, undefined, (reservation) => {
      mutationIds.push(reservation.mutationId);
    }),
    mutationIntents: {
      claim: async (operation, semanticInput) => {
        const claim = await memory.claim(operation, semanticInput);
        return {
          mutationId: claim.mutationId,
          reused: claim.reused,
          complete: async () => {
            await claim.complete();
            confirmedSettlement();
          },
          retain: async () => await claim.retain()
        };
      }
    }
  });

  const concurrent = await Promise.allSettled([
    api.createStory("shared"),
    api.createStory("shared")
  ]);
  expect(concurrent.map(({ status }) => status).sort()).toEqual([
    "fulfilled",
    "rejected"
  ]);
  expect((await api.createStory("shared")).id).toBe("shared");
  expect(endpointCalls).toBe(4);
  expect(new Set(mutationIds).size).toBe(1);
});

test("HTTP StoryApi pages, deduplicates, and sorts the bounded catalog", async () => {
  const reservations: Record<string, unknown>[] = [];
  const cursor = "b".repeat(64);
  let pageCalls = 0;
  globalThis.fetch = (async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/health") return Response.json(metadata());
    if (path !== "/api/stories/catalog-page") {
      throw new Error(`Unexpected catalog path: ${path}`);
    }
    pageCalls += 1;
    return Response.json(
      pageCalls === 1
        ? catalogPage([
          storySummary("a", "2026-01-01T00:00:00.000Z", 1),
          storySummary("b", "2026-02-01T00:00:00.000Z", 1)
        ], cursor)
        : pageCalls === 2
          ? catalogPage([
              storySummary("a", "2026-03-01T00:00:00.000Z", 2),
              storySummary("c", "2026-02-15T00:00:00.000Z", 1)
            ], cursor)
          : catalogPage()
    );
  }) as typeof fetch;
  const api = createApi(
    "http://127.0.0.1:7373",
    undefined,
    (reservation) => reservations.push(reservation)
  );

  expect((await api.listStories()).map(({ id }) => id)).toEqual(["a", "c", "b"]);
  expect(reservations.map(({ path }) => path)).toEqual([
    "/api/stories/catalog-page",
    "/api/stories/catalog-page",
    "/api/stories/catalog-page"
  ]);
  expect(reservations.map(({ mutationId }) => mutationId)).toEqual([
    undefined,
    undefined,
    undefined
  ]);
  expect(pageCalls).toBe(3);
});

test("HTTP StoryApi restarts one expired catalog scan from a null cursor", async () => {
  const cursors: unknown[] = [];
  const cursor = "c".repeat(64);
  globalThis.fetch = (async (input, init) => {
    if (String(input).endsWith("/api/health")) {
      return Response.json(metadata());
    }
    const body = JSON.parse(String(init?.body)) as {
      cursor: unknown;
    };
    cursors.push(body.cursor);
    if (cursors.length === 1) {
      return Response.json(
        catalogPage([storySummary("stale", "2026-01-01T00:00:00.000Z", 1)], cursor)
      );
    }
    if (cursors.length === 2) {
      return Response.json({
        error: "Catalog cursor expired; start a fresh scan.",
        code: "catalog_cursor_expired"
      }, { status: 409 });
    }
    return Response.json(
      catalogPage([storySummary("fresh", "2026-02-01T00:00:00.000Z", 1)])
    );
  }) as typeof fetch;
  const api = createApi("http://127.0.0.1:7373");

  expect((await api.listStories()).map(({ id }) => id)).toEqual(["fresh"]);
  expect(cursors).toEqual([null, cursor, null]);
});

test("HTTP StoryApi bounds repeated catalog cursor expiry to one restart", async () => {
  const cursor = "d".repeat(64);
  let pageCalls = 0;
  globalThis.fetch = (async (input, init) => {
    if (String(input).endsWith("/api/health")) {
      return Response.json(metadata());
    }
    pageCalls += 1;
    const body = JSON.parse(String(init?.body)) as {
      cursor: string | null;
    };
    return body.cursor === null
      ? Response.json(catalogPage([], cursor))
      : Response.json({
          error: "Catalog cursor expired; start a fresh scan.",
          code: "catalog_cursor_expired"
        }, { status: 409 });
  }) as typeof fetch;
  const api = createApi("http://127.0.0.1:7373");

  const error = await rejection(api.listStories());
  expect(error).toMatchObject({ code: "catalog_cursor_expired" });
  expect(pageCalls).toBe(4);
});

test("HTTP StoryApi freezes retry preconditions before durable dispatch", async () => {
  const reservations: Record<string, unknown>[] = [];
  const autonameBodies: unknown[] = [];
  const removalBodies: unknown[] = [];
  const removedFingerprint = "f".repeat(64);
  const current = { ...storyPayload("story"), title: "Original" };
  const validBreak = chapterBreak("break");
  const removal = {
    payload: storyPayload("story"),
    removed: { break: validBreak, summaries: [] }
  };
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/health")) return Response.json(metadata());
    if (url.endsWith("/preview")) {
      return Response.json({
        removedFingerprint,
        aggregateVersion: storyPayload("story").aggregateVersion
      });
    }
    if ((init?.method ?? "GET") === "GET") return Response.json(current);
    const body: unknown = JSON.parse(String(init?.body));
    if (url.endsWith("/autoname")) {
      autonameBodies.push(body);
      if (autonameBodies.length === 1) {
        throw new TypeError("socket closed after autoname commit");
      }
      return Response.json({ ...current, title: "Named" });
    }
    removalBodies.push(body);
    if (removalBodies.length === 1) {
      throw new TypeError("socket closed after chapter removal commit");
    }
    return Response.json(removal);
  }) as typeof fetch;
  const api = createApi(
    "http://127.0.0.1:7373",
    undefined,
    (reservation) => reservations.push(reservation)
  );

  expect((await api.autonameStory("story")).title).toBe("Named");
  expect((await api.removeChapterBreak("story", "break")).removed.break.id)
    .toBe("break");

  expect(autonameBodies).toEqual([
    { expectedTitle: "Original" },
    { expectedTitle: "Original" }
  ]);
  expect(removalBodies).toEqual([
    { removedFingerprint },
    { removedFingerprint }
  ]);
  for (const path of [
    "/api/stories/story/autoname",
    "/api/stories/story/chapter-breaks/break"
  ]) {
    const durable = reservations.filter(
      (reservation) => reservation.path === path
    );
    expect(durable).toHaveLength(2);
    expect(typeof durable[0]?.mutationId).toBe("string");
    expect(durable[1]?.mutationId).toBe(durable[0]?.mutationId);
    expect(durable.map((reservation) =>
      reservation.expectedAggregateVersion)).toEqual([
      storyPayload("story").aggregateVersion,
      storyPayload("story").aggregateVersion
    ]);
  }
});

test("HTTP StoryApi carries service codes for settings conflict recovery", async () => {
  let settingsHeaders = new Headers();
  globalThis.fetch = (async (input, init) => {
    if (String(input).endsWith("/api/health")) return Response.json(metadata());
    settingsHeaders = new Headers(init?.headers);
    return Response.json(
      {
        error: "Settings changed since this edit began.",
        code: "revision_conflict"
      },
      { status: 409 }
    );
  }) as typeof fetch;

  const error = await rejection(createApi("http://127.0.0.1:7373").getSettings());
  expect(error instanceof ApiHttpError).toBeTrue();
  expect((error as ApiHttpError).status).toBe(409);
  expect((error as ApiHttpError).code).toBe("revision_conflict");
  expect(settingsHeaders.get(HTTP_AUTHORIZATION_HEADER)).toBe(`Bearer ${"dd".repeat(32)}`);
});

test("HTTP settings reservations retain each command mutation identity", async () => {
  const reservations: Record<string, unknown>[] = [];
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (input, init) => {
    if (String(input).endsWith("/api/health")) {
      return Response.json(metadata());
    }
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({
      kind: "settings",
      settingsStateGeneration: 2,
      activeSettingsRevision: 2,
      pendingSettingsRevision: null,
      activationOutcome: null
    });
  }) as typeof fetch;
  const api = createApi(
    "http://127.0.0.1:7373",
    undefined,
    (reservation) => reservations.push(reservation)
  );
  const saveMutationId =
    "m1.1767225600000.0123456789abcdef0123456789abcdef";
  const discardMutationId =
    "m1.1767225600001.1123456789abcdef0123456789abcdef";

  await api.saveSettings({
    transportOperationId: "settings-save",
    mutationId: saveMutationId,
    expectedStateGeneration: 1,
    document: DEMO_SETTINGS_DOCUMENT
  });
  await api.discardPendingSettings({
    transportOperationId: "settings-discard",
    mutationId: discardMutationId,
    expectedStateGeneration: 2
  });

  expect(reservations.map(({ mutationId }) => mutationId)).toEqual([
    saveMutationId,
    discardMutationId
  ]);
  expect(bodies.map(({ mutationId }) => mutationId)).toEqual([
    saveMutationId,
    discardMutationId
  ]);
});

test("operation admission refusal remains an online application error", async () => {
  globalThis.fetch = (async () => Response.json(metadata())) as typeof fetch;
  const raw = createApi(
    "http://127.0.0.1:7373",
    undefined,
    () => Response.json(
      { error: "Operation capacity is full", code: "resource_busy" },
      { status: 429 }
    )
  );
  const monitor = createConnectionMonitor(raw);
  const error = await rejection(monitor.api.createStory("capacity"));

  expect(error instanceof ApiHttpError).toBeTrue();
  expect((error as ApiHttpError).status).toBe(429);
  expect((error as ApiHttpError).code).toBe("resource_busy");
  expect((error as ApiHttpError).requestSent).toBeFalse();
  expect(monitor.state().down).toBeFalse();
  monitor.dispose();
});

test("HTTP StoryApi validates chapter summaries at ingress and preserves legacy summary takes", async () => {
  let story: Record<string, unknown> = storyPayload("story", [
    storyStub("chapter-summary", { role: "summary", chapterBreakId: "break", text: "Recap" })
  ]);
  globalThis.fetch = (async (input) => String(input).endsWith("/api/health")
    ? Response.json(metadata())
    : Response.json(story)) as typeof fetch;
  const api = createApi("http://127.0.0.1:7373");

  expect((await rejection(api.loadStory("story")) as Error).message).toContain("not provider-ready");

  story = storyPayload("story", [storyStub("legacy-summary", { role: "summary" })]);
  expect((await api.loadStory("story")).nodes[0]?.role).toBe("summary");

  story = { id: "story", path: [], nodes: [] };
  expect((await rejection(api.loadStory("story")) as Error).message).toContain("story payload.title");
});

test("HTTP StoryApi rejects malformed direct and chapter endpoint envelopes", async () => {
  let response: unknown = { ...storyPayload("story"), nodes: null };
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.endsWith("/api/health")) return Response.json(metadata());
    if (url.endsWith("/preview")) {
      return Response.json({
        removedFingerprint: "f".repeat(64),
        aggregateVersion: storyPayload("story").aggregateVersion
      });
    }
    return Response.json(response);
  }) as typeof fetch;
  const api = createApi("http://127.0.0.1:7373");

  expect((await rejection(api.loadStory("story")) as Error).message).toContain("story payload");

  response = storyPayload("story");
  await api.loadStory("story");
  response = { breakId: "break" };
  expect((await rejection(api.createChapterBreak("story", "part")) as Error).message)
    .toContain("story payload");

  response = { payload: storyPayload("story"), breakId: 42 };
  expect((await rejection(api.createChapterBreak("story", "part")) as Error).message)
    .toContain("creation response.breakId");

  response = { payload: storyPayload("story"), breakId: "break" };
  expect((await api.createChapterBreak("story", "part")).breakId).toBe("break");

  response = { payload: { ...storyPayload("story"), nodes: null }, removed: {} };
  expect((await rejection(api.removeChapterBreak("story", "break")) as Error).message)
    .toContain("story payload");

  const validBreak = chapterBreak("break");
  const validSummary = storyNode("summary", {
    parentId: "part",
    role: "summary",
    chapterBreakId: "break"
  });
  const validRemoval = {
    payload: storyPayload("story"),
    removed: { break: validBreak, summaries: [validSummary] }
  };
  response = validRemoval;
  expect((await api.removeChapterBreak("story", "break")).removed.summaries[0]?.id).toBe("summary");

  for (const [malformed, expected] of [
    [{ ...validRemoval, removed: null }, "removed chapter-break"],
    [{ ...validRemoval, removed: { break: {}, summaries: [] } }, "chapter break.id"],
    [{ ...validRemoval, removed: { break: validBreak, summaries: {} } }, "summaries"],
    [{ ...validRemoval, removed: { break: validBreak, summaries: [validSummary, { id: "summary" }] } }, "story path node"]
  ] as const) {
    response = malformed;
    expect((await rejection(api.removeChapterBreak("story", "break")) as Error).message)
      .toContain(expected);
  }
});

test("HTTP StoryApi rejects malformed successful responses for every response family", async () => {
  const settings = {
    provider: "dry-run" as const,
    baseUrl: "",
    model: "",
    apiKeyEnv: null,
    temperature: 0.9,
    maxTokens: 1024,
    systemPrompt: "Continue the story.",
    contextWindow: null
  };
  const settingsView = {
    ...DEMO_SETTINGS_VIEW,
    effective: settings,
    effectiveProse: settings
  };
  const command = {
    transportOperationId: "transport-operation",
    mutationId: "m1.0000000000000.00000000000000000000000000000000",
    expectedStateGeneration: 1,
    document: DEMO_SETTINGS_DOCUMENT
  };
  let response: unknown = settingsView;
  globalThis.fetch = (async (input) => String(input).endsWith("/api/health")
    ? Response.json(metadata())
    : Response.json(response)) as typeof fetch;
  const api = createApi("http://127.0.0.1:7373");
  const deleteWithCurrentResponse = async () => {
    const deletionResponse = response;
    response = storyPayload("story");
    await api.loadStory("story");
    response = deletionResponse;
    return await api.deleteStory("story");
  };

  expect(await api.getSettings()).toEqual(settingsView);
  const legacyView = {
    dataFormat: 1 as const,
    editable: false as const,
    stateGeneration: null,
    activeRevision: null,
    pendingRevision: null,
    document: null,
    effective: {
      ...settings,
      model: "cafe\u0301",
      systemPrompt: "Continue cafe\u0301."
    },
    effectiveProse: {
      ...settings,
      model: "cafe\u0301",
      systemPrompt: "Continue cafe\u0301."
    },
    lastActivationOutcome: null
  };
  response = legacyView;
  expect(await api.getSettings()).toEqual(legacyView);
  response = { ok: true };
  expect(await deleteWithCurrentResponse()).toEqual({ ok: true });
  const { effectiveProse: _effectiveProse, ...withoutEffectiveProse } = settingsView;
  const malformed: Array<[unknown, () => Promise<unknown>, string]> = [
    [catalogPage([{
      id: "story", title: "Story", updatedAt: "today", partCount: 1,
      words: 10, forked: "yes", lineCount: 1
    }]), () => api.listStories(), "story summary.forked"],
    [catalogPage([{
      id: "story", title: "Story", updatedAt: "today", partCount: -1,
      words: 10, forked: false, lineCount: 1
    }]), () => api.listStories(), "story summary.partCount"],
    [{ ok: "yes" }, deleteWithCurrentResponse, "story deletion response.ok"],
    [{ ok: false }, deleteWithCurrentResponse, "story deletion response.ok"],
    [withoutEffectiveProse, () => api.getSettings(), "settings view"],
    [{ ...settingsView, effective: { ...settings, provider: "other" } }, () => api.getSettings(), "generation settings.provider"],
    [{
      ...settingsView,
      stateGeneration: Number.MAX_SAFE_INTEGER + 1
    }, () => api.getSettings(), "settings view.stateGeneration"],
    [{
      ...settingsView,
      document: {
        ...DEMO_SETTINGS_DOCUMENT,
        connections: {
          demo: {
            ...DEMO_SETTINGS_DOCUMENT.connections.demo!,
            timeouts: {
              ...DEMO_SETTINGS_DOCUMENT.connections.demo!.timeouts,
              firstTokenMs: "slow"
            }
          }
        }
      }
    }, () => api.getSettings(), "connection demo.timeouts.firstTokenMs"],
    [{
      ...settingsView,
      document: {
        ...DEMO_SETTINGS_DOCUMENT,
        profiles: {
          default: {
            ...DEMO_SETTINGS_DOCUMENT.profiles.default!,
            modelId: "constructor"
          }
        }
      }
    }, () => api.getSettings(), "profile default.modelId does not resolve"],
    [{
      ...settingsView,
      document: {
        ...DEMO_SETTINGS_DOCUMENT,
        writing: { defaultAuthorBrief: "e\u0301" }
      }
    }, () => api.getSettings(), "NFC-normalized"],
    [{
      kind: "settings",
      settingsStateGeneration: 2,
      activeSettingsRevision: 2,
      pendingSettingsRevision: "later",
      activationOutcome: null
    }, () => api.saveSettings(command), "settings mutation result.pendingSettingsRevision"],
    [{
      kind: "settings",
      settingsStateGeneration: Number.MAX_SAFE_INTEGER + 1,
      activeSettingsRevision: 2,
      pendingSettingsRevision: null,
      activationOutcome: null
    }, () => api.saveSettings(command), "settings mutation result.settingsStateGeneration"],
    [{ state: "maybe", message: "No" }, () => api.checkModelServer(settings), "model-server check response.state"],
    [{ contextWindow: "large" }, () => api.probeContextWindow(settings), "context-window probe response.contextWindow"],
    [{
      observedAt: "not-a-date",
      models: []
    }, () => api.discoverModels(settings), "model discovery result"]
  ];
  for (const [payload, request, expected] of malformed) {
    response = payload;
    expect((await rejection(request()) as Error).message).toContain(expected);
  }
});

test("concurrent HTTP mutations reject replacement instances before sending operations", async () => {
  const healthResolvers: Array<(response: Response) => void> = [];
  const operations: Array<{ title: string; serverInstanceId: string | null }> = [];
  globalThis.fetch = (async (input, init) => {
    if (String(input).endsWith("/api/health")) {
      return await new Promise<Response>((resolve) => { healthResolvers.push(resolve); });
    }
    const body = JSON.parse(String(init?.body)) as { title: string };
    operations.push({
      title: body.title,
      serverInstanceId: new Headers(init?.headers).get(HTTP_SERVER_INSTANCE_HEADER)
    });
    return Response.json(storyPayload(body.title));
  }) as typeof fetch;
  const api = createApi("http://127.0.0.1:7373");
  const first = api.createStory("first");
  const second = api.createStory("second");
  await waitFor(() => healthResolvers.length === 2);
  expect(healthResolvers).toHaveLength(2);

  const firstInstance = "33333333-3333-4333-8333-333333333333";
  const secondInstance = "44444444-4444-4444-8444-444444444444";
  healthResolvers[0]!(Response.json(metadata(firstInstance)));
  healthResolvers[1]!(Response.json(metadata(secondInstance)));
  const results = await Promise.allSettled([first, second]);

  expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
  expect(operations).toEqual([]);
});

test("HTTP StoryApi gives autoname a provider-scale deadline", async () => {
  const timeouts: number[] = [];
  const originalTimeout = AbortSignal.timeout;
  Object.defineProperty(AbortSignal, "timeout", {
    configurable: true,
    value: (milliseconds: number) => {
      timeouts.push(milliseconds);
      return new AbortController().signal;
    }
  });
  try {
    globalThis.fetch = (async (input) => {
      const url = String(input);
      return url.endsWith("/api/health")
        ? Response.json(metadata())
        : Response.json(storyPayload("story"));
    }) as typeof fetch;

    await createApi("http://127.0.0.1:7373").autonameStory("story");
    expect(timeouts).toContain(HTTP_GENERATION_REQUEST_TIMEOUT_MS);
    expect(Math.max(...timeouts)).toBe(
      HTTP_GENERATION_REQUEST_TIMEOUT_MS
    );
    expect(HTTP_GENERATION_REQUEST_TIMEOUT_MS).toBeGreaterThan(120_000);
    expect(HTTP_GENERATION_REQUEST_TIMEOUT_MS).toBe(
      HTTP_OPERATION_LIFETIME_MS.generation
    );
  } finally {
    Object.defineProperty(AbortSignal, "timeout", { configurable: true, value: originalTimeout });
  }
});

test("HTTP provider failure invalidates the held story revision", async () => {
  let providerFailed = false;
  let storyLoads = 0;
  const mutationVersions: unknown[] = [];
  const payload = (revision: string) => ({
    ...storyPayload("story"),
    aggregateVersion: {
      kind: "v6",
      revision
    }
  });
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/health") return Response.json(metadata());
    if (path === "/api/stories/story"
      && (init?.method ?? "GET") === "GET") {
      storyLoads += 1;
      return Response.json(payload(providerFailed
        ? "00000000000000000002"
        : "00000000000000000001"));
    }
    if (path === "/api/stories/story/autoname") {
      providerFailed = true;
      return Response.json({
        error: "Model request failed.",
        code: "provider_failure"
      }, { status: 502 });
    }
    if (path === "/api/stories/story" && init?.method === "PATCH") {
      return Response.json(payload("00000000000000000003"));
    }
    throw new Error(`Unexpected API path: ${path}`);
  }) as typeof fetch;
  const api = createApi(
    "http://127.0.0.1:7373",
    undefined,
    (reservation) => {
      if (reservation.path === "/api/stories/story/autoname"
        || (reservation.path === "/api/stories/story"
          && reservation.method === "PATCH")) {
        mutationVersions.push(reservation.expectedAggregateVersion);
      }
    }
  );

  await api.loadStory("story");
  const error = await rejection(api.autonameStory("story"));
  expect(error instanceof ApiHttpError).toBeTrue();
  expect((error as ApiHttpError).code).toBe("provider_failure");
  await api.renameStory("story", "Renamed");

  expect(storyLoads).toBe(3);
  expect(mutationVersions).toEqual([
    {
      kind: "v6",
      revision: "00000000000000000001"
    },
    {
      kind: "v6",
      revision: "00000000000000000002"
    }
  ]);
});

test("HTTP generation cancellation invalidates the held story revision", async () => {
  const cancel = new AbortController();
  let generationCanceled = false;
  let storyLoads = 0;
  const mutationVersions: unknown[] = [];
  const payload = (revision: string) => ({
    ...storyPayload("story"),
    aggregateVersion: {
      kind: "v6",
      revision
    }
  });
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/health") return Response.json(metadata());
    if (path === "/api/stories/story"
      && (init?.method ?? "GET") === "GET") {
      storyLoads += 1;
      return Response.json(payload(generationCanceled
        ? "00000000000000000002"
        : "00000000000000000001"));
    }
    if (path === "/api/stories/story/continue") {
      generationCanceled = true;
      cancel.abort();
      return new Response(
        'data: {"type":"delta","text":"kept"}\n\n',
        { headers: { "content-type": "text/event-stream" } }
      );
    }
    if (path === "/api/stories/story" && init?.method === "PATCH") {
      return Response.json(payload("00000000000000000003"));
    }
    throw new Error(`Unexpected API path: ${path}`);
  }) as typeof fetch;
  const api = createApi(
    "http://127.0.0.1:7373",
    undefined,
    (reservation) => {
      if (reservation.path === "/api/stories/story/continue"
        || (reservation.path === "/api/stories/story"
          && reservation.method === "PATCH")) {
        mutationVersions.push(reservation.expectedAggregateVersion);
      }
    }
  );

  await api.loadStory("story");
  expect(await api.continueStory(
    "story",
    "",
    "cancelled-generation",
    {},
    () => {},
    cancel.signal
  )).toBe(null);
  await api.renameStory("story", "Renamed");

  expect(storyLoads).toBe(2);
  expect(mutationVersions).toEqual([
    {
      kind: "v6",
      revision: "00000000000000000001"
    },
    {
      kind: "v6",
      revision: "00000000000000000002"
    }
  ]);
});

test("HTTP generation lease expiry is an error, not user cancellation", async () => {
  const baseUrl = "http://127.0.0.1:7373";
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/health") return Response.json(metadata());
    if (path === "/api/stories/story"
      && (init?.method ?? "GET") === "GET") {
      return Response.json(storyPayload("story"));
    }
    return await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener(
        "abort",
        () => reject(signal.reason),
        { once: true }
      );
    });
  }) as typeof fetch;
  const api = createApi(baseUrl, undefined, () => Response.json({
    listenerInstanceId: metadata().serverInstanceId,
    sessionId: "aa".repeat(16),
    sequence: "1",
    ticket: `${"aa".repeat(16)}.1.${"ee".repeat(32)}`,
    lifetime: "generation",
    deadlineEpochMs: Date.now() + 40,
    startDeadlineEpochMs: Date.now() + 40
  }, { status: 201 }));
  await api.loadStory("story");

  const result = await rejection(api.continueStory(
    "story",
    "",
    "generation-id",
    {},
    () => {},
    new AbortController().signal
  ));

  expect(result instanceof ApiHttpError).toBe(true);
  expect((result as ApiHttpError).status).toBe(408);
  expect((result as ApiHttpError).code).toBe("operation_expired");
  expect(String((result as Error).message)).toContain("Reload the story");
});

test("HTTP provider operations request their full transport-parity lifetimes", async () => {
  const reservations: Record<string, unknown>[] = [];
  const importBodies: unknown[] = [];
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/health") return Response.json(metadata());
    if (path === "/api/stories/story") {
      return Response.json(storyPayload("story"));
    }
    if (path.endsWith("/summarize")) {
      return Response.json(storyPayload("story"));
    }
    if (path === "/api/settings/probe-context") {
      return Response.json({ contextWindow: 32_768 });
    }
    if (path === "/api/settings/discover-models") {
      return Response.json({
        observedAt: "2026-01-01T00:00:00.000Z",
        models: []
      });
    }
    if (path.endsWith("/export")) return new Response("# Story\n");
    if (path === "/api/import/sillytavern") {
      return Response.json(storyPayload("imported"));
    }
    if (path === "/api/import/markdown") {
      importBodies.push(decodeMarkdownHttpBody(String(init?.body)));
      return Response.json(storyPayload("markdown-imported"));
    }
    if (path === "/api/import/novelai") {
      return Response.json(storyPayload("novelai-imported"));
    }
    throw new Error(`Unexpected API path: ${path}`);
  }) as typeof fetch;
  const api = createApi(
    "http://127.0.0.1:7373",
    undefined,
    (reservation) => reservations.push(reservation)
  );
  await api.loadStory("story");
  reservations.length = 0;

  await api.summarizeChapter("story", "chapter");
  await api.probeContextWindow(DEMO_SETTINGS_VIEW.effective);
  await api.discoverModels(DEMO_SETTINGS_VIEW.effective);
  await api.exportMarkdown("story");
  await api.importSillyTavern("{}");
  await api.importMarkdown("Opening prose.", "Draft title");
  await api.importNovelAI("{}");

  expect(importBodies).toEqual([{
    markdown: "Opening prose.",
    defaultTitle: "Draft title"
  }]);

  expect(reservations.map((reservation) =>
    reservation.requestedLifetimeMs)).toEqual([
    HTTP_OPERATION_LIFETIME_MS.generation,
    WORKER_PROVIDER_CHECK_TIMEOUT_MS,
    WORKER_PROVIDER_CHECK_TIMEOUT_MS,
    HTTP_OPERATION_LIFETIME_MS.transfer,
    HTTP_OPERATION_LIFETIME_MS.transfer,
    HTTP_OPERATION_LIFETIME_MS.transfer,
    HTTP_OPERATION_LIFETIME_MS.transfer
  ]);
});

test("HTTP StoryApi blocks reads after a seamless server replacement", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input) => {
    calls.push(String(input));
    if (calls.length === 1) return Response.json(metadata());
    if (calls.length === 2) return Response.json(catalogPage());
    return Response.json(incompatibleMetadata());
  }) as typeof fetch;
  const api = createApi("http://127.0.0.1:7373");

  expect(await api.listStories()).toEqual([]);
  expect((await rejection(api.listStories()) as Error).message).toContain("Incompatible");
  expect(calls).toEqual([
    "http://127.0.0.1:7373/api/health",
    "http://127.0.0.1:7373/api/stories/catalog-page",
    "http://127.0.0.1:7373/api/health"
  ]);
});

test("HTTP StoryApi rejects DNS loopback before compatibility fetch", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input) => {
    calls.push(String(input));
    return Response.json(incompatibleMetadata());
  }) as typeof fetch;

  let error: unknown;
  try {
    await createApi("http://localhost:7373").listStories();
  } catch (caught) {
    error = caught;
  }
  expect(error instanceof Error).toBeTrue();
  expect((error as Error).message).toContain("canonical numeric loopback");
  expect(calls).toEqual([]);
});

test("HTTP StoryApi rejects an older compatibility range and malformed metadata", async () => {
  for (const response of [
    metadata(undefined, {
      apiProtocolVersion: HTTP_API_PROTOCOL_VERSION - 1,
      minClientProtocolVersion: HTTP_API_PROTOCOL_VERSION - 1,
      maxClientProtocolVersion: HTTP_API_PROTOCOL_VERSION - 1
    }),
    {
      ...metadata(),
      buildIdentity: { ...metadata().buildIdentity, minClientProtocolVersion: "one" }
    }
  ]) {
    const calls: string[] = [];
    globalThis.fetch = (async (input) => {
      calls.push(String(input));
      return Response.json(response);
    }) as typeof fetch;

    expect(await rejection(createApi("http://127.0.0.1:7373").listStories()) instanceof Error).toBeTrue();
    expect(calls).toEqual(["http://127.0.0.1:7373/api/health"]);
  }
});

test("HTTP StoryApi accepts a newer server that declares this client compatible", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input) => {
    calls.push(String(input));
    if (calls.length === 1) return Response.json(metadata(undefined, {
      apiProtocolVersion: HTTP_API_PROTOCOL_VERSION + 1,
      minClientProtocolVersion: HTTP_API_PROTOCOL_VERSION,
      maxClientProtocolVersion: HTTP_API_PROTOCOL_VERSION + 1
    }));
    return Response.json(catalogPage());
  }) as typeof fetch;

  expect(await createApi("http://127.0.0.1:7373").listStories()).toEqual([]);
  expect(calls).toHaveLength(2);
});

test("HTTP StoryApi retries compatibility after a transient preflight failure", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input) => {
    calls.push(String(input));
    if (calls.length === 1) return Response.json({ error: "restarting" }, { status: 503 });
    if (calls.length === 2) return Response.json(metadata());
    return Response.json(catalogPage());
  }) as typeof fetch;
  const api = createApi("http://127.0.0.1:7373");

  expect(await rejection(api.listStories()) instanceof Error).toBeTrue();
  expect(await api.listStories()).toEqual([]);
  expect(calls).toEqual([
    "http://127.0.0.1:7373/api/health",
    "http://127.0.0.1:7373/api/health",
    "http://127.0.0.1:7373/api/stories/catalog-page"
  ]);
});

test("HTTP StoryApi renegotiates compatibility after transport loss", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input) => {
    calls.push(String(input));
    if (calls.length === 1) return Response.json(metadata());
    if (calls.length === 2) return Response.json(catalogPage());
    if (calls.length === 3) throw new TypeError("connection reset");
    return Response.json(incompatibleMetadata());
  }) as typeof fetch;
  const api = createApi("http://127.0.0.1:7373");

  expect(await api.listStories()).toEqual([]);
  expect((await rejection(api.listStories()) as Error).message).toContain("connection reset");
  expect((await rejection(api.listStories()) as Error).message).toContain("Incompatible");
  expect(calls).toEqual([
    "http://127.0.0.1:7373/api/health",
    "http://127.0.0.1:7373/api/stories/catalog-page",
    "http://127.0.0.1:7373/api/health",
    "http://127.0.0.1:7373/api/health"
  ]);
});

test("HTTP StoryApi preflights mutations after a seamless server replacement", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input) => {
    calls.push(String(input));
    if (calls.length === 1) return Response.json(metadata());
    if (calls.length === 2) return Response.json(catalogPage());
    return Response.json(incompatibleMetadata());
  }) as typeof fetch;
  const api = createApi("http://127.0.0.1:7373");

  expect(await api.listStories()).toEqual([]);
  expect((await rejection(api.createStory("must not send")) as Error).message).toContain("Incompatible");
  expect(calls).toEqual([
    "http://127.0.0.1:7373/api/health",
    "http://127.0.0.1:7373/api/stories/catalog-page",
    "http://127.0.0.1:7373/api/health"
  ]);
});

test("HTTP StoryApi blocks the mutation that first reports recovered state", async () => {
  const calls: string[] = [];
  let fresh = true;
  globalThis.fetch = (async (input) => {
    calls.push(String(input));
    return String(input).endsWith("/api/health")
      ? Response.json(metadata())
      : Response.json(storyPayload("story"));
  }) as typeof fetch;
  const api = createApi("http://127.0.0.1:7373", () => {
    const result = fresh;
    fresh = false;
    return result;
  });

  expect((await rejection(api.createStory("stale input")) as Error).message).toContain("operation was not sent");
  expect(calls).toEqual(["http://127.0.0.1:7373/api/health"]);
  expect((await api.createStory("reviewed input")).id).toBe("story");
  expect(calls).toEqual([
    "http://127.0.0.1:7373/api/health",
    "http://127.0.0.1:7373/api/health",
    "http://127.0.0.1:7373/api/stories"
  ]);
});

test("HTTP StoryApi blocks a raw import that first reports recovered state", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input) => {
    calls.push(String(input));
    return Response.json(metadata());
  }) as typeof fetch;
  const api = createApi("http://127.0.0.1:7373", () => true);

  expect((await rejection(api.importSillyTavern("{\"name\":\"stale\"}")) as Error).message)
    .toContain("operation was not sent");
  expect(calls).toEqual(["http://127.0.0.1:7373/api/health"]);
});

test("HTTP StoryApi stream cancellation covers compatibility preflight", async () => {
  const cancel = new AbortController();
  let calls = 0;
  globalThis.fetch = (async (_input, init) => {
    calls += 1;
    const signal = init?.signal;
    return await new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      cancel.abort();
    });
  }) as typeof fetch;
  const api = createApi("http://127.0.0.1:7373");

  const result = await api.continueStory("story", "", "gen", {}, () => {}, cancel.signal);
  expect(result).toBe(null);
  expect(calls).toBe(1);
});

test("HTTP StoryApi cancels story-version preflight on the server", async () => {
  const baseUrl = "http://127.0.0.1:7373";
  const cancel = new AbortController();
  let markVersionStarted!: () => void;
  const versionStarted = new Promise<void>((resolve) => {
    markVersionStarted = resolve;
  });
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/health") return Response.json(metadata());
    if (path === "/api/stories/story") {
      markVersionStarted();
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          { once: true }
        );
      });
    }
    throw new Error(`Unexpected API path: ${path}`);
  }) as typeof fetch;
  const access = testHttpAccess(baseUrl);
  const binding = access.authority.snapshot();
  let stopCalls = 0;
  const api = createHttpApi(baseUrl, undefined, {
    authority: new HttpListenerAuthority({
      root: baseUrl,
      binding: {
        authRecord: binding.authRecord,
        fetch: async (input, init) => {
          const path = new URL(String(input), baseUrl).pathname;
          if (path !== "/api/operations/cancel") {
            return await binding.fetch(input, init);
          }
          stopCalls += 1;
          const [sessionId, sequence] = (
            new Headers(init?.headers).get(HTTP_OPERATION_TICKET_HEADER) ?? ""
          ).split(".");
          return Response.json({
            listenerInstanceId: metadata().serverInstanceId,
            sessionId,
            sequence,
            state: "running",
            terminal: false,
            cancelRequested: true
          });
        }
      }
    })
  });

  const pending = api.continueStory(
    "story",
    "",
    "gen",
    {},
    () => {},
    cancel.signal
  );
  await versionStarted;
  cancel.abort();

  expect(await pending).toBe(null);
  expect(stopCalls).toBe(1);
});

function catalogPage(
  items: Array<Record<string, unknown>> = [],
  cursor: string | null = null
) {
  return {
    scanId: "a".repeat(32),
    items,
    cursor,
    done: cursor === null
  };
}

function storySummary(
  id: string,
  updatedAt: string,
  revision: number
): Record<string, unknown> {
  return {
    id,
    title: id,
    updatedAt,
    partCount: 0,
    words: 0,
    forked: false,
    lineCount: 0,
    aggregateVersion: {
      kind: "v6",
      revision: String(revision).padStart(20, "0")
    }
  };
}

function storyStub(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    parentId: null,
    preview: "",
    words: 0,
    tokens: 0,
    childCount: 0,
    leafCount: 1,
    lastTouched: "2026-07-21T00:00:00.000Z",
    hasInstruction: false,
    activeChildId: null,
    ...extra
  };
}

function storyNode(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    parentId: null,
    instruction: "",
    text: "Recap",
    model: "test",
    createdAt: "2026-07-21T00:00:00.000Z",
    activeChildId: null,
    ...extra
  };
}

function chapterBreak(id: string): Record<string, unknown> {
  return {
    id,
    parentPartId: "part",
    title: "Chapter two",
    createdAt: "2026-07-21T00:00:00.000Z"
  };
}

function incompatibleMetadata() {
  return metadata(undefined, {
    apiProtocolVersion: HTTP_API_PROTOCOL_VERSION + 1,
    minClientProtocolVersion: HTTP_API_PROTOCOL_VERSION + 1,
    maxClientProtocolVersion: HTTP_API_PROTOCOL_VERSION + 1
  });
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise to reject");
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for asynchronous test state");
}
