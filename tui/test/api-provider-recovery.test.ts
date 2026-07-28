import { afterEach, expect, test } from "bun:test";
import {
  createTestApi,
  testHttpMetadata,
  testStoryPayload
} from "./http-api-fixture.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("HTTP recovery leaves provider-fence selection to the server", async () => {
  const warningMutationId =
    "m1.1767225600000.0123456789abcdef0123456789abcdef";
  const dataPaths: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const requestPath = new URL(String(input)).pathname;
    if (requestPath === "/api/health") {
      return Response.json(testHttpMetadata());
    }
    dataPaths.push(`${init?.method ?? "GET"} ${requestPath}`);
    if (requestPath.endsWith(
      `/unknown-outcomes/${warningMutationId}`
    )) {
      return Response.json({
        state: "pending",
        deleted: false,
        aggregateVersion: {
          kind: "v6",
          revision: "00000000000000000002"
        }
      });
    }
    if (requestPath.endsWith(
      `/unknown-outcomes/${warningMutationId}/ack`
    )) {
      return Response.json({
        ...testStoryPayload("story"),
        aggregateVersion: {
          kind: "v6",
          revision: "00000000000000000003"
        }
      });
    }
    throw new Error(`Unexpected API path: ${requestPath}`);
  }) as typeof fetch;

  const recovered = await createTestApi(
    "http://127.0.0.1:7373"
  ).acknowledgeUnknownOutcomes("story", warningMutationId);

  expect(recovered?.aggregateVersion).toEqual({
    kind: "v6",
    revision: "00000000000000000003"
  });
  expect(dataPaths).toEqual([
    `GET /api/stories/story/unknown-outcomes/${warningMutationId}`,
    `POST /api/stories/story/unknown-outcomes/${warningMutationId}/ack`
  ]);
});
