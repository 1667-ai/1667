/**
 * Browser-safe read of `/api/status`'s `update` field — the background update
 * check's result, which `host/web-server.ts` publishes and the web UI shows
 * as a toast. The raw `fetch` traffic only; `web/src/app/update-notice.ts`
 * owns when to call this and how often.
 *
 * `client/web-bridge-connect.ts` already reads `/api/status` once while it
 * connects, and its `WebBridgeStatus` carries the same field, so a page
 * normally starts from that answer and calls this only while the check is
 * still pending. Living in `client/` (not `web/`) keeps the web UI inside
 * its own import boundary (`web/` may reach `client/` and `shared/` only —
 * see `test/frontend-import-boundary.test.ts`).
 */
import {
  normalizeUpdateNoticeStatus,
  type UpdateNoticeStatus
} from "../shared/update-notice.js";

export interface UpdateNoticeApi {
  load(): Promise<UpdateNoticeStatus>;
}

/** `fetchImpl` and `token` are both explicit parameters (never a captured
 * global), the same way `client/reading-positions-api.ts` takes them. */
export function createUpdateNoticeApi(
  fetchImpl: typeof fetch,
  token: string
): UpdateNoticeApi {
  const authorization = `Bearer ${token}`;
  return {
    load: async () => {
      const response = await fetchImpl("/api/status", { headers: { authorization } });
      if (!response.ok) {
        throw new Error(`1667 web: GET /api/status returned ${response.status}`);
      }
      const body = await response.json() as { update?: unknown };
      return normalizeUpdateNoticeStatus(body.update);
    }
  };
}
