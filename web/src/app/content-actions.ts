import { createComposeActions, type ComposeActions } from "../compose/actions.js";
import type { ContextActions } from "../context/actions.js";
import type { EditorActions } from "../editor/actions.js";
import { createGenerationActions, type GenerationActions } from "../generation/actions.js";
import type { FlushScheduler } from "../generation/stream-buffer.js";
import { createThoughtActions, type ThoughtActions } from "../inspect/thoughts.js";
import { createLibraryActions, type LibraryActions } from "../library/actions.js";
import { createPanelActions, type PanelActions } from "../panel/actions.js";
import type { TagsActions } from "../tags/actions.js";
import { createStoryActions, type StoryActions } from "../story/actions.js";
import { createPartCommands, type PartCommands } from "../story/part-commands.js";
import type { AsideActions } from "../aside/actions.js";
import type { AsideUseActions } from "../aside/use-actions.js";
import type { ChapterActions } from "../chapters/actions.js";
import type { FactActions } from "../facts/index.js";
import type { FactCheckActions } from "../factcheck/actions.js";
import type { ImportActions } from "../imports/actions.js";
import type { NotesActions } from "../notes/actions.js";
import type { SettingsActions } from "../settings/actions.js";
import { lazyActionsOf, lazyActions, lazyLoader } from "./lazy-actions.js";
import { storyRunLocked } from "./run-lock.js";
import type { AppState } from "./state.js";
import type { Store } from "./store.js";

export interface ContentActions {
  readonly library: LibraryActions;
  readonly story: StoryActions;
  readonly generation: GenerationActions;
  readonly part: PartCommands;
  readonly compose: ComposeActions;
  readonly context: ContextActions;
  readonly editor: EditorActions;
  readonly tags: TagsActions;
  readonly chapters: ChapterActions;
  readonly panel: PanelActions;
  readonly aside: AsideActions & AsideUseActions;
  readonly facts: FactActions;
  readonly factCheck: FactCheckActions;
  readonly imports: ImportActions;
  readonly notes: NotesActions;
  readonly thoughts: ThoughtActions;
  readonly settings: SettingsActions;
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
    isLocked: (storyId) => storyRunLocked(store.get(), storyId)
  });
  const library = createLibraryActions(store, { titleChanged: story.titleChanged });
  const generation = createGenerationActions(store, {
    adoptPayload: story.adoptPayload,
    ...(deps.createScheduler === undefined ? {} : { createScheduler: deps.createScheduler })
  });
  const compose = createComposeActions(store, { story, generation });
  const contextLoader = lazyLoader(store, async () => (await import("../context/actions.js")).createContextActions(store));
  const contextView = lazyActionsOf(contextLoader);
  const context: ContextActions = {
    toggleExpanded: () => contextView.toggleExpanded(),
    setExpanded: (expanded) => contextView.setExpanded(expanded),
    // Follows the store once the context code has loaded; the meter is a
    // detail of the composer and never holds up the first screen.
    start: () => {
      let stop = (): void => {};
      let stopped = false;
      void contextLoader.ensure().then((module) => { if (!stopped) stop = module.start(); }, () => undefined);
      return () => { stopped = true; stop(); };
    }
  };
  const editor = lazyActions<EditorActions>(store, async () => {
    void import("../editor/PartEditor.js").catch(() => undefined);
    return (await import("../editor/actions.js")).createEditorActions(store, { story });
  });
  const tags = lazyActions<TagsActions>(store, async () => {
    void import("../tags/TagPopover.js").catch(() => undefined);
    return (await import("../tags/actions.js")).createTagActions(store, { story });
  });
  // These modules are only needed once a writer opens their view, so they
  // download then (see `lazyActions`). Each one reaches the others only through
  // the actions given here.
  const chapters = lazyActions<ChapterActions>(
    store,
    async () => (await import("../chapters/actions.js")).createChapterActions(store, { story }),
    { stopSummary: () => false }
  );
  const panel = createPanelActions(store);
  const facts = lazyActions<FactActions>(store, async () => (await import("../facts/index.js")).createFactActions(store, { story, panel }));
  const factCheck = lazyActions<FactCheckActions>(store, async () => (await import("../factcheck/actions.js")).createFactCheckActions(store, { story, panel }));
  const aside = lazyActions<AsideActions & AsideUseActions>(
    store,
    async () => (await import("../aside/index.js")).createAllAsideActions(store, { story, compose, facts, panel }),
    { stop: () => false }
  );
  const imports = lazyActions<ImportActions>(store, async () => (await import("../imports/actions.js")).createImportActions(store, { story, library }));
  const notes = lazyActions<NotesActions>(store, async () => (await import("../notes/actions.js")).createNotesActions(store, { story }));
  const thoughts = createThoughtActions(store);
  const part = createPartCommands(store, { story, generation, compose, editor, tags, chapters, facts, panel });
  const settings = lazyActions<SettingsActions>(
    store,
    async () => (await import("../settings/actions.js")).createSettingsActions(store),
    { deleteProfile: () => null }
  );
  return { library, story, generation, part, compose, context, editor, tags, chapters, panel, aside, facts, factCheck, imports, notes, settings, thoughts };
}
