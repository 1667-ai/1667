import { expect, test } from "bun:test";
import { createTestApi as createApi } from "./http-api-fixture.js";
import { AI_1667_BUILD_IDENTITY } from "../../shared/build-identity.js";
import type { SearchHit, SearchRequest } from "../../shared/story-search.js";

const BASE = "http://127.0.0.1:7373";

/** One well-formed hit, so a case can spoil exactly the field it is about. */
function hit(overrides: Partial<SearchHit> = {}): SearchHit {
  return {
    storyId: "story",
    storyTitle: "the lantern keeper",
    kind: "prose",
    targetId: "part",
    depth: 12,
    snippet: "he set the brass compass on the bar",
    snippetMatch: 17,
    matchLength: 7,
    context: "…he set the brass compass on the bar between them",
    contextMatch: 18,
    ...overrides
  };
}

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    query: "compass",
    scope: "tree",
    caseSensitive: false,
    hits: [hit()],
    capped: false,
    storiesSearched: 1,
    ...overrides
  };
}

const REQUEST: SearchRequest = {
  query: "compass",
  scope: "tree",
  storyId: "story",
  caseSensitive: false
};

/** Answer the health preflight, then hand one canned body to every search. */
function stubServer(response: unknown, seen?: Array<{ path: string; body: unknown }>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/health")) {
      return Response.json({
        buildIdentity: AI_1667_BUILD_IDENTITY,
        dataDirectoryClaimId: "ca".repeat(32),
        dataDirectoryId: "aa".repeat(32),
        serverInstanceId: "11111111-1111-4111-8111-111111111111",
        recoveryWarnings: []
      });
    }
    seen?.push({
      path: new URL(url).pathname,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body))
    });
    return Response.json(response);
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

test("the HTTP client posts the query to the search route and decodes the answer", async () => {
  const seen: Array<{ path: string; body: unknown }> = [];
  const restore = stubServer(body(), seen);
  try {
    const response = await createApi(BASE).searchStories(REQUEST);
    expect(response.hits).toHaveLength(1);
    expect(response.hits[0]!.storyTitle).toBe("the lantern keeper");
    expect(response.scope).toBe("tree");
    expect(response.capped).toBeFalse();
    // The route is written in the router, the policy table and here. A client
    // that posted anywhere else would never reach the server's search.
    expect(seen.map(({ path }) => path)).toEqual(["/api/stories/search"]);
    expect(seen[0]!.body).toEqual({
      query: "compass",
      scope: "tree",
      storyId: "story",
      caseSensitive: false
    });
  } finally {
    restore();
  }
});

test("the HTTP client preserves an optional Fact State landing id", async () => {
  const restore = stubServer(body({
    hits: [hit({ kind: "fact", targetId: "fact-1", stateId: "state-2", depth: 0 })]
  }));
  try {
    const response = await createApi(BASE).searchStories(REQUEST);
    expect(response.hits[0]).toMatchObject({
      kind: "fact",
      targetId: "fact-1",
      stateId: "state-2"
    });
  } finally {
    restore();
  }
});

test("the client refuses a response whose offsets do not index its own strings", async () => {
  // These offsets travel beside the strings they cut, and the renderer slices
  // highlights with them. A server that got them wrong must not paint.
  const spoiled: Array<[string, Record<string, unknown>]> = [
    ["snippet match runs past the snippet", { snippetMatch: 30, matchLength: 7 }],
    ["context match runs past the context", { contextMatch: 46, matchLength: 7 }],
    ["negative snippet match", { snippetMatch: -1 }],
    ["unknown hit kind", { kind: "chapter" }],
    ["missing snippet", { snippet: undefined }]
  ];
  for (const [name, overrides] of spoiled) {
    const restore = stubServer(body({ hits: [{ ...hit(), ...overrides }] }));
    try {
      let refused = false;
      try {
        await createApi(BASE).searchStories(REQUEST);
      } catch {
        refused = true;
      }
      expect(`${name}: ${refused}`).toBe(`${name}: true`);
    } finally {
      restore();
    }
  }
});

test("the client refuses a search envelope it cannot trust", async () => {
  const spoiled: Array<[string, Record<string, unknown>]> = [
    ["unknown scope", { scope: "line" }],
    ["hits are not a list", { hits: {} }],
    ["capped is not a flag", { capped: "no" }],
    ["stories searched is not a count", { storiesSearched: -2 }]
  ];
  for (const [name, overrides] of spoiled) {
    const restore = stubServer(body(overrides));
    try {
      let refused = false;
      try {
        await createApi(BASE).searchStories(REQUEST);
      } catch {
        refused = true;
      }
      expect(`${name}: ${refused}`).toBe(`${name}: true`);
    } finally {
      restore();
    }
  }
});

test("an aborted search never reaches the network", async () => {
  const seen: Array<{ path: string; body: unknown }> = [];
  const restore = stubServer(body(), seen);
  try {
    const controller = new AbortController();
    controller.abort();
    let refused = false;
    try {
      await createApi(BASE).searchStories(REQUEST, controller.signal);
    } catch {
      refused = true;
    }
    expect(refused).toBeTrue();
    expect(seen).toHaveLength(0);
  } finally {
    restore();
  }
});
