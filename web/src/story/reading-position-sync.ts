import type { ReadingPositionsApi } from "../../../client/reading-positions-api.js";

/**
 * Per-connection reading-position cache and debounced writer (#409 step 4
 * review fix). Replaces two bugs a pair of module-level `let`s had:
 *
 * 1. The old cache fetched the server's positions once and never learned
 *    this tab's own writes, so opening story A, focusing part 2, opening
 *    story B, then reopening A recomputed A's opening focus from the
 *    connection-time snapshot — losing part 2 — and a `revision_conflict`
 *    reload did the same. `record` here updates the in-memory map
 *    synchronously, so `positionFor` always reflects this tab's latest
 *    write even before it reaches the server.
 * 2. A single pending-write cell meant switching to story B while story A's
 *    write was still debouncing silently dropped A's write. `record` now
 *    debounces per story id.
 *
 * One instance lives on the `connected` `ConnectionState` (`app/connection.ts`),
 * built once per connection — never module scope — so a reconnect starts
 * clean rather than carrying a stale positions map or pending writes across
 * to a new bridge.
 */
export interface ReadingPositionSync {
  /** This tab's own most recent `record` for `storyId` if there is one,
   * otherwise the server's own value from the one-time full fetch (fetched
   * lazily, memoized for the life of this instance). */
  positionFor(storyId: string): Promise<string | null>;
  /** Updates the in-memory position immediately (so a `positionFor` call
   * right after this always sees it) and (re)schedules that story's
   * debounced write, independent of any other story's pending write. */
  record(storyId: string, partId: string): void;
  /** Sends every story's still-pending write immediately, in parallel —
   * `app/bootstrap.ts` calls this on `pagehide`/visibility hidden with
   * `keepalive: true` so the browser still sends them while the tab closes. */
  flush(options?: { readonly keepalive?: boolean }): void;
}

const DEBOUNCE_MS = 400;

export function createReadingPositionSync(api: ReadingPositionsApi): ReadingPositionSync {
  let remote: Promise<Readonly<Record<string, string>>> | null = null;
  const local = new Map<string, string>();
  const pending = new Map<string, { partId: string; timer: ReturnType<typeof setTimeout> }>();

  function loadRemote(): Promise<Readonly<Record<string, string>>> {
    remote ??= api.load().catch((error: unknown) => {
      console.warn("1667 web: failed to load reading positions", error);
      return {};
    });
    return remote;
  }

  function send(storyId: string, partId: string, options: { readonly keepalive?: boolean } = {}): void {
    api.set(storyId, partId, options).catch((error: unknown) => {
      console.warn("1667 web: failed to save the reading position", error);
    });
  }

  return {
    positionFor: async (storyId) => {
      const recorded = local.get(storyId);
      if (recorded !== undefined) return recorded;
      const positions = await loadRemote();
      return positions[storyId] ?? null;
    },

    record: (storyId, partId) => {
      local.set(storyId, partId);
      const existing = pending.get(storyId);
      if (existing !== undefined) clearTimeout(existing.timer);
      const timer = setTimeout(() => {
        pending.delete(storyId);
        send(storyId, partId);
      }, DEBOUNCE_MS);
      pending.set(storyId, { partId, timer });
    },

    flush: (options) => {
      for (const [storyId, entry] of pending) {
        clearTimeout(entry.timer);
        send(storyId, entry.partId, options);
      }
      pending.clear();
    }
  };
}
