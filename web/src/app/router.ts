/**
 * Hash routes: `#/` (library home), `#/story/<id>`, and `#/story/<id>/map`
 * (the story's map: still the story's route, so a story's actions treat it as
 * open). `web-bridge-connect.ts`'s
 * token read only ever looks at `hash`'s `token` query key
 * (`new URLSearchParams(hash).get("token")`), so a route hash with no such
 * key — every route here — safely falls through to `storage` instead, and
 * `clearTokenFragment` is only ever invoked when a token was actually found.
 * That already held before this router existed (verified by inspection, not
 * changed): a `#/story/<id>` hash is never mistaken for a token carrier.
 */
export type Route =
  | { readonly kind: "library" }
  | { readonly kind: "story"; readonly id: string; readonly map?: true };

const STORY_PREFIX = "#/story/";
const MAP_SUFFIX = "/map";

export function parseRoute(hash: string): Route {
  if (hash.startsWith(STORY_PREFIX)) {
    const rest = hash.slice(STORY_PREFIX.length);
    const map = rest.endsWith(MAP_SUFFIX);
    const id = decodeURIComponent(map ? rest.slice(0, -MAP_SUFFIX.length) : rest);
    if (id.length > 0) return map ? { kind: "story", id, map: true } : { kind: "story", id };
  }
  return { kind: "library" };
}

export function currentRoute(): Route {
  return parseRoute(location.hash);
}

export function routeHash(route: Route): string {
  if (route.kind === "library") return "#/";
  return `${STORY_PREFIX}${encodeURIComponent(route.id)}${route.map === true ? MAP_SUFFIX : ""}`;
}

export function navigate(route: Route): void {
  location.hash = routeHash(route);
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
  location.replace(routeHash({ kind: "story", id: storyId }));
}

export function listenForRouteChanges(onChange: (route: Route) => void): () => void {
  const handler = (): void => {
    const route = currentRoute();
    if (route.kind !== "story" || route.id !== mapOpenedFrom) mapOpenedFrom = null;
    onChange(route);
  };
  addEventListener("hashchange", handler);
  return () => removeEventListener("hashchange", handler);
}
