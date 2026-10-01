import { createComposeActions, type ComposeActions } from "../compose/actions.js";
import { createGenerationActions, type GenerationActions } from "../generation/actions.js";
import type { FlushScheduler } from "../generation/stream-buffer.js";
import { generationLocks } from "../generation/state.js";
import { createLibraryActions, type LibraryActions } from "../library/actions.js";
import { createStoryActions, type StoryActions } from "../story/actions.js";
import { createPartActions, type PartActions } from "../story/part-actions.js";
import type { AppState } from "./state.js";
import type { Store } from "./store.js";

export interface ContentActions {
  readonly library: LibraryActions;
  readonly story: StoryActions;
  readonly generation: GenerationActions;
  readonly part: PartActions;
  readonly compose: ComposeActions;
}

/**
 * Wires the feature action modules that act on stories (`library`, `story`,
 * `generation`) over one store. Split from `createAppActions` so an
 * integration test can build the real wiring without the theme module,
 * which reads browser-only globals when it loads.
 *
 * `library` and `story` share one hook (`story.titleChanged`) so a rename
 * updates whichever story is open without either module writing into the
 * other's state directly; `story` and `generation` share a similar pair —
 * `story.adoptPayload` for a landed generation, and `generationLocks` (a
 * pure read of `state.generation`, not an action reference) for `story`'s
 * own take-switch lock.
 */
export function createContentActions(
  store: Store<AppState>,
  deps: { readonly createScheduler?: () => FlushScheduler } = {}
): ContentActions {
  // `story` needs `library.refresh` (a landed take switch can change the
  // Library row it shows) and `library` needs `story.titleChanged` (a rename
  // updates the open story) — each reads the other only through a callback
  // invoked later, never at construction time, so declaring `story` first
  // and having its callback close over the not-yet-assigned `library` is
  // safe (the same trick `app/bootstrap.ts` uses for `onConnected`/`actions`).
  const story = createStoryActions(store, {
    storyChanged: () => { void library.refresh(); },
    isLocked: (storyId) => generationLocks(store.get().generation, storyId)
  });
  const library = createLibraryActions(store, { titleChanged: story.titleChanged });
  const generation = createGenerationActions(store, {
    adoptPayload: story.adoptPayload,
    ...(deps.createScheduler === undefined ? {} : { createScheduler: deps.createScheduler })
  });
  const part = createPartActions(store, {
    story,
    generation,
    isLocked: (storyId) => generationLocks(store.get().generation, storyId)
  });
  const compose = createComposeActions(store, { story, generation });
  return { library, story, generation, part, compose };
}

