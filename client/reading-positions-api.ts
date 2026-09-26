/**
 * Browser-safe HTTP calls for `host/web-server.ts`'s durable reading
 * positions (#409 step 4) — the raw `fetch` traffic only; the web app owns
 * caching, debouncing, and when to call these
 * (`web/src/story/reading-position-sync.ts`). Living in `client/` (not
 * `web/`) keeps the web UI inside its own import boundary (`web/` may reach
 * `client/` and `shared/` only — see `test/frontend-import-boundary.test.ts`).
 */
import { normalizeReadingPositions, type ReadingPositions } from "../shared/reading-position.js";

export interface ReadingPositionsApi {
  load(): Promise<ReadingPositions>;
  /** `partId: null` deletes the story's stored position. Fire-and-forget at
   * the call site; this still returns the underlying `fetch` promise so a
   * caller that wants to await or catch it (or pass `keepalive`) still can. */
  set(storyId: string, partId: string | null, options?: { readonly keepalive?: boolean }): Promise<void>;
}

/** `fetchImpl` and `token` are both explicit parameters (never a captured
 * global) so this stays testable the way `client/web-bridge-connect.ts` is. */
export function createReadingPositionsApi(
  fetchImpl: typeof fetch,
  token: string
): ReadingPositionsApi {
  const authorization = `Bearer ${token}`;
  return {
    load: async () => {
      const response = await fetchImpl("/api/reading-positions", {
        headers: { authorization }
      });
      if (!response.ok) {
        throw new Error(`1667 web: GET /api/reading-positions returned ${response.status}`);
      }
      const body = await response.json() as { positions?: unknown };
      return normalizeReadingPositions(body.positions);
    },
    set: async (storyId, partId, options = {}) => {
      const response = await fetchImpl(`/api/reading-positions/${encodeURIComponent(storyId)}`, {
        method: "PUT",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ partId }),
        keepalive: options.keepalive ?? false
      });
      if (!response.ok) {
        throw new Error(`1667 web: PUT /api/reading-positions/${storyId} returned ${response.status}`);
      }
    }
  };
}
