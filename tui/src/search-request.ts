import { searchQueryIsRunnable } from "../../shared/story-search.js";
import type { AppSource } from "./app.js";
import { firstHitCursor, searchRows, type SearchState } from "./search-model.js";
import type { RuntimeState } from "./state.js";

/** Stop the scan behind a request nobody is waiting for. A vault scan reads
 *  stories off disk, so an abandoned query still competes with the live one. */
export function abortPendingSearch(search: SearchState): void {
  const pending = search.pending;
  if (pending === null) return;
  search.pending = null;
  pending.abort();
}

/** Retire the results of a query when its context has been replaced. */
export function retireSearch(search: SearchState): void {
  abortPendingSearch(search);
  search.response = null;
  search.cursor = 0;
}

/**
 * Ask the backend for the current query.
 *
 * Every keystroke fires one request. Controller identity (`search.pending === pending`)
 * is the fence: a response is adopted only while it is still the active request,
 * so out-of-order arrivals cannot overwrite a later query's results.
 *
 * The settled response is dropped as the request goes out. Keeping it would
 * paint hits from the previous query, scope or case under the new header —
 * and `enter` would travel to one of them.
 *
 * The request it replaces is aborted rather than merely ignored: a vault scan
 * reads stories off disk, so a query nobody is waiting for still competes with
 * the one that is.
 */
export function runSearch(
  state: RuntimeState,
  search: SearchState,
  source: AppSource,
  repaint: () => void
): void {
  const query = search.query.trim();
  search.response = null;
  search.error = null;
  search.cursor = 0;
  abortPendingSearch(search);
  if (!searchQueryIsRunnable(query)) return;

  const pending = new AbortController();
  search.pending = pending;
  // The payload is the fence, not just the story id. Only adoption replaces it
  // — a stream mutates its own view, never this object — so requiring the same
  // payload rejects exactly the responses that describe a story which has since
  // changed, and rejects nothing while the writer is generating.
  const payload = state.payload;
  const owns = () => state.search === search
    && search.pending === pending
    && state.payload === payload;

  void source.api.searchStories({
    query,
    scope: search.scope,
    storyId: state.payload.id,
    caseSensitive: search.caseSensitive
  }, pending.signal).then((response) => {
    if (!owns()) return;
    search.pending = null;
    search.response = response;
    search.cursor = firstHitCursor(searchRows(search, state.payload));
    repaint();
  }, (error: unknown) => {
    if (!owns()) return;
    search.pending = null;
    search.response = null;
    search.error = error instanceof Error ? error.message : String(error);
    repaint();
  });
}
