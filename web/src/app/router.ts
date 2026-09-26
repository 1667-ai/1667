/**
 * Hash routes: `#/` (library home) and `#/story/<id>`. `web-bridge-connect.ts`'s
 * token read only ever looks at `hash`'s `token` query key
 * (`new URLSearchParams(hash).get("token")`), so a route hash with no such
 * key — every route here — safely falls through to `storage` instead, and
 * `clearTokenFragment` is only ever invoked when a token was actually found.
 * That already held before this router existed (verified by inspection, not
 * changed): a `#/story/<id>` hash is never mistaken for a token carrier.
 */
export type Route =
  | { readonly kind: "library" }
  | { readonly kind: "story"; readonly id: string };

const STORY_PREFIX = "#/story/";

export function parseRoute(hash: string): Route {
  if (hash.startsWith(STORY_PREFIX)) {
    const id = decodeURIComponent(hash.slice(STORY_PREFIX.length));
    if (id.length > 0) return { kind: "story", id };
  }
  return { kind: "library" };
}

export function currentRoute(): Route {
  return parseRoute(location.hash);
}

export function routeHash(route: Route): string {
  return route.kind === "library" ? "#/" : `${STORY_PREFIX}${encodeURIComponent(route.id)}`;
}

export function navigate(route: Route): void {
  location.hash = routeHash(route);
}

export function listenForRouteChanges(onChange: (route: Route) => void): () => void {
  const handler = (): void => onChange(currentRoute());
  addEventListener("hashchange", handler);
  return () => removeEventListener("hashchange", handler);
}
