/**
 * Hash routes: `#/` (library home), `#/story/<id>`, and `#/story/<id>/map`
 * (the story's map: still the story's route, so a story's actions treat it as
 * open), and `#/settings` (the settings page, which belongs to no story). `web-bridge-connect.ts`'s
 * token read only ever looks at `hash`'s `token` query key
 * (`new URLSearchParams(hash).get("token")`), so a route hash with no such
 * key — every route here — safely falls through to `storage` instead, and
 * `clearTokenFragment` is only ever invoked when a token was actually found.
 * That already held before this router existed (verified by inspection, not
 * changed): a `#/story/<id>` hash is never mistaken for a token carrier.
 */
/** A full page of a story other than its own page and the map: the next
 * request, and a take's generation records and token probabilities. */
export type StoryPage =
  | { readonly kind: "request" }
  | { readonly kind: "records"; readonly nodeId: string }
  | { readonly kind: "probs"; readonly nodeId: string };

export type Route =
  | { readonly kind: "library" }
  | { readonly kind: "settings" }
  | { readonly kind: "story"; readonly id: string; readonly map?: true; readonly page?: StoryPage };

/** True on the story's own page: not its map, not an inspector page. */
export function isStoryPage(route: Route): route is Extract<Route, { kind: "story" }> {
  return route.kind === "story" && route.map !== true && route.page === undefined;
}

const STORY_PREFIX = "#/story/";
const SETTINGS_HASH = "#/settings";

export function parseRoute(hash: string): Route {
  if (hash === SETTINGS_HASH) return { kind: "settings" };
  if (hash.startsWith(STORY_PREFIX)) {
    const [rawId = "", section, rawNode] = hash.slice(STORY_PREFIX.length).split("/");
    const id = decodeURIComponent(rawId);
    if (id.length === 0) return { kind: "library" };
    if (section === "map" && rawNode === undefined) return { kind: "story", id, map: true };
    if (section === "request" && rawNode === undefined) return { kind: "story", id, page: { kind: "request" } };
    if ((section === "records" || section === "probs") && rawNode !== undefined && rawNode.length > 0) {
      return { kind: "story", id, page: { kind: section, nodeId: decodeURIComponent(rawNode) } };
    }
    return { kind: "story", id };
  }
  return { kind: "library" };
}

export function currentRoute(): Route {
  return parseRoute(location.hash);
}

export function routeHash(route: Route): string {
  if (route.kind === "library") return "#/";
  if (route.kind === "settings") return SETTINGS_HASH;
  const story = `${STORY_PREFIX}${encodeURIComponent(route.id)}`;
  if (route.map === true) return `${story}/map`;
  if (route.page === undefined) return story;
  return route.page.kind === "request" ? `${story}/request` : `${story}/${route.page.kind}/${encodeURIComponent(route.page.nodeId)}`;
}

/** Goes to `route` as a new history entry, so Back returns here. `replace`
 * swaps the current entry instead (for a page that is gone, like a deleted
 * story, which Back must not show again). */
export function navigate(route: Route, options: { readonly replace?: boolean } = {}): void {
  if (options.replace === true) location.replace(routeHash(route));
  else location.hash = routeHash(route);
}

/** The story whose map this tab opened from the story's own page: the history
 * entry below the map is that page, so closing the map steps back to it. */
let mapOpenedFrom: string | null = null;

/** Opens the story's map as its own page (Back closes it). */
export function openMap(storyId: string): void {
  mapOpenedFrom = storyId;
  navigate({ kind: "story", id: storyId, map: true });
}

/** Closes the map: back one entry when the map was opened from the story in
 * this tab, else a replacement, so Back never reopens it. */
export function closeMap(storyId: string): void {
  if (mapOpenedFrom === storyId) {
    mapOpenedFrom = null;
    history.back();
    return;
  }
  navigate({ kind: "story", id: storyId }, { replace: true });
}

/** The story whose page this tab left to open an inspector page: the entry
 * below it is that page, so closing the inspector steps back to it. */
let pageOpenedFrom: string | null = null;

/** Opens an inspector page (Back closes it). */
export function openStoryPage(storyId: string, page: StoryPage): void {
  pageOpenedFrom = storyId;
  navigate({ kind: "story", id: storyId, page });
}

/** Closes an inspector page: back one entry when it was opened from the
 * story in this tab, else a replacement, so Back never reopens it. */
export function closeStoryPage(storyId: string): void {
  if (pageOpenedFrom === storyId) {
    pageOpenedFrom = null;
    history.back();
    return;
  }
  navigate({ kind: "story", id: storyId }, { replace: true });
}

/** True when the history entry below the settings page is a page of this app:
 * the page was opened here, or arrived through Back or Forward. Closing then
 * steps back; a page opened by its address replaces itself with the Library,
 * so Back never reopens it. */
let settingsHasPageBelow = false;

/** The story the writer came from, while settings is open on top of it: the
 * settings page offers the story's own sampling lists for it. A page opened by
 * its address, or from the Library, has none. */
let storyBelowSettings: string | null = null;

function noteStoryRoute(route: Route): void {
  if (route.kind === "story") storyBelowSettings = route.id;
  else if (route.kind === "library") storyBelowSettings = null;
}

export function settingsStory(): string | null {
  return storyBelowSettings;
}

/** Opens the settings page (Back closes it). */
export function openSettings(): void {
  noteStoryRoute(currentRoute());
  if (currentRoute().kind === "settings") return;
  settingsHasPageBelow = true;
  navigate({ kind: "settings" });
}

export function closeSettings(): void {
  if (settingsHasPageBelow) {
    settingsHasPageBelow = false;
    history.back();
    return;
  }
  navigate({ kind: "library" }, { replace: true });
}

export function listenForRouteChanges(onChange: (route: Route) => void): () => void {
  const handler = (): void => {
    const route = currentRoute();
    if (route.kind !== "story" || route.id !== mapOpenedFrom) mapOpenedFrom = null;
    if (route.kind !== "story" || route.id !== pageOpenedFrom) pageOpenedFrom = null;
    settingsHasPageBelow = route.kind === "settings";
    noteStoryRoute(route);
    onChange(route);
  };
  addEventListener("hashchange", handler);
  return () => removeEventListener("hashchange", handler);
}
