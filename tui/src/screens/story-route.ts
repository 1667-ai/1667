import type { StoryScreenState } from "../state.js";

/** The mutually exclusive top-level route selected by renderStoryScreen. */
export type StoryScreenRoute =
  | { readonly kind: "log" }
  | { readonly kind: "search"; readonly search: NonNullable<StoryScreenState["search"]> }
  | { readonly kind: "map"; readonly map: NonNullable<StoryScreenState["map"]> }
  | { readonly kind: "record"; readonly record: NonNullable<StoryScreenState["record"]> }
  | { readonly kind: "request"; readonly request: NonNullable<StoryScreenState["request"]> }
  | { readonly kind: "probs"; readonly probs: NonNullable<StoryScreenState["probs"]> }
  | { readonly kind: "aside"; readonly aside: NonNullable<StoryScreenState["aside"]> }
  | { readonly kind: "editor"; readonly editor: NonNullable<StoryScreenState["editor"]> }
  | { readonly kind: "fullscreen-composer" }
  | { readonly kind: "page" };

/** Select one renderer and keep its precedence in one place. */
export function resolveStoryScreenRoute(state: StoryScreenState): StoryScreenRoute {
  if (state.mode === "LOG") return { kind: "log" };
  if (state.mode === "SEARCH" && state.search !== null) {
    return { kind: "search", search: state.search };
  }
  if (state.map !== null && (state.mode === "MAP"
    || state.mode === "TAG" && state.tag?.returnMode === "MAP")) {
    return { kind: "map", map: state.map };
  }
  if (state.mode === "RECORD" && state.record !== null) {
    return { kind: "record", record: state.record };
  }
  if (state.mode === "REQUEST" && state.request !== null) {
    return { kind: "request", request: state.request };
  }
  if (state.mode === "PROBS" && state.probs !== null) {
    return { kind: "probs", probs: state.probs };
  }
  if (state.mode === "ASIDE" && state.aside !== null) {
    return { kind: "aside", aside: state.aside };
  }
  if (state.mode === "EDITOR" && state.editor !== null) {
    return { kind: "editor", editor: state.editor };
  }
  if (state.mode === "COMPOSE" && state.composer.fullscreen) {
    return { kind: "fullscreen-composer" };
  }
  return { kind: "page" };
}

/** Full-screen routes own every visible cell. Keep them in one native text
 * buffer so mouse selection can cross the width where the page rail normally
 * begins. Only the story page needs the prose/rail split. */
export function routeUsesSinglePane(route: StoryScreenRoute): boolean {
  return route.kind !== "page";
}

/** Report whether the selected renderer draws state.toast. */
export function routeShowsToast(route: StoryScreenRoute): boolean {
  switch (route.kind) {
    case "log":
    case "search":
    case "record":
    case "request":
    case "probs":
      return false;
    case "aside":
      return !route.aside.busy;
    case "map":
    case "editor":
    case "fullscreen-composer":
    case "page":
      return true;
    default: {
      const exhaustive: never = route;
      return exhaustive;
    }
  }
}
