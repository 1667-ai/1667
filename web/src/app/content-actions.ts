import { createAsideActions, type AsideActions } from "../aside/actions.js";
import { createAsideUseActions, type AsideUseActions } from "../aside/use-actions.js";
import { createComposeActions, type ComposeActions } from "../compose/actions.js";
import { createContextActions, type ContextActions } from "../context/actions.js";
import { createEditorActions, type EditorActions } from "../editor/actions.js";
import { createFactActions, type FactActions } from "../facts/index.js";
import { createImportActions, type ImportActions } from "../imports/actions.js";
import { createFactCheckActions, type FactCheckActions } from "../factcheck/actions.js";
import { createGenerationActions, type GenerationActions } from "../generation/actions.js";
import type { FlushScheduler } from "../generation/stream-buffer.js";
import { createLibraryActions, type LibraryActions } from "../library/actions.js";
import { createChapterActions, type ChapterActions } from "../chapters/actions.js";
import { createNotesActions, type NotesActions } from "../notes/actions.js";
import { createPanelActions, type PanelActions } from "../panel/actions.js";
import { createSettingsActions, type SettingsActions } from "../settings/actions.js";
import { createTagActions, type TagsActions } from "../tags/actions.js";
import { createStoryActions, type StoryActions } from "../story/actions.js";
import { createPartCommands, type PartCommands } from "../story/part-commands.js";
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
  const context = createContextActions(store);
  const editor = createEditorActions(store, { story });
  const tags = createTagActions(store, { story });
  const chapters = createChapterActions(store, { story });
  const panel = createPanelActions(store);
  const facts = createFactActions(store, { story, panel });
  const factCheck = createFactCheckActions(store, { story, panel });
  const aside = { ...createAsideActions(store, { story, panel }), ...createAsideUseActions(store, { story, compose, facts, panel }) };
  const imports = createImportActions(store, { story, library });
  const notes = createNotesActions(store, { story });
  const part = createPartCommands(store, { story, generation, compose, editor, tags, chapters, facts, panel });
  const settings = createSettingsActions(store);
  return { library, story, generation, part, compose, context, editor, tags, chapters, panel, aside, facts, factCheck, imports, notes, settings };
}

