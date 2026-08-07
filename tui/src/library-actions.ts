import type { AppSource } from "./app.js";
import type { ActionContext } from "./action-context.js";
import { globalEditor } from "./editor-scope.js";
import { applyTextKey, isPlainNavigation, type ResolvedKey } from "./keys.js";
import {
  boundedLibraryCursor,
  libraryRows,
  setLibraryQuery,
  typedTitleMatches
} from "./library-model.js";
import { publishStories } from "./overlay-publication.js";
import {
  flushReadingPositionPersist,
  forgetStoryReadingPosition
} from "./reading-position-persist.js";
import { adoptReconciliationSnapshot, adoptSameStoryPayload, adoptStoryState } from "./story-adoption.js";
import type { RuntimeState, TextPrompt } from "./state.js";

export interface OpenLibraryOptions {
  selectedStoryId?: string;
  prompt?: TextPrompt;
}

export async function openLibrary(
  state: RuntimeState,
  source: AppSource,
  context: ActionContext,
  options: OpenLibraryOptions = {}
): Promise<void> {
  const selectedIndex = options.selectedStoryId === undefined
    ? 0
    : libraryRows(source.stories, "").findIndex((story) => story.id === options.selectedStoryId);
  const overlay = {
    stories: source.stories,
    cursor: Math.max(0, selectedIndex),
    query: "",
    prompt: options.prompt ?? null
  };
  state.library = overlay;
  state.mode = "LIBRARY";
  context.repaint();
  if (state.connection.down) return;
  await context.backend.run("refreshing library", async (task) => {
    try {
      const stories = await source.api.listStories();
      if (task.owns()) publishStories(state, source, stories);
    } catch { /* connection decorator owns the banner */ }
  });
}

export async function libraryAction(
  resolved: ResolvedKey,
  state: RuntimeState,
  source: AppSource,
  context: ActionContext
): Promise<boolean> {
  const overlay = state.library!;
  const rows = libraryRows(overlay.stories, overlay.query);
  const selected = rows[Math.min(overlay.cursor, Math.max(0, rows.length - 1))];
  if (resolved.action === "cancel") {
    if (overlay.prompt?.kind === "filter") {
      const initial = overlay.prompt.initial;
      overlay.query = initial.query;
      const restoredRows = libraryRows(overlay.stories, overlay.query);
      const restoredIndex = initial.storyId === null
        ? -1
        : restoredRows.findIndex((story) => story.id === initial.storyId);
      overlay.cursor = restoredIndex >= 0
        ? restoredIndex
        : boundedLibraryCursor(
            initial.cursor,
            restoredRows.length
          );
      overlay.prompt = null;
    } else if (overlay.prompt !== null) overlay.prompt = null;
    else { state.library = null; state.mode = "NAV"; }
  } else if (resolved.action === "focus-next") {
    overlay.cursor = boundedLibraryCursor(overlay.cursor + 1, rows.length);
  }
  else if (resolved.action === "focus-index") {
    overlay.cursor = boundedLibraryCursor(resolved.index ?? overlay.cursor, rows.length);
  }
  else if (resolved.action === "focus-previous") overlay.cursor = Math.max(0, overlay.cursor - 1);
  else if (resolved.action === "filter") {
    overlay.prompt = {
      kind: "filter",
      initial: {
        query: overlay.query,
        cursor: overlay.cursor,
        storyId: selected?.id ?? null
      }
    };
  }
  else if (resolved.action === "rename-item" && selected !== undefined) overlay.prompt = { kind: "rename", value: selected.title, targetId: selected.id };
  else if (resolved.action === "delete-item" && selected !== undefined) overlay.prompt = { kind: "delete", value: "", targetId: selected.id };
  else if ((resolved.action === "backspace" || resolved.action === "input") && overlay.prompt !== null) {
    if (overlay.prompt.kind === "filter") {
      setLibraryQuery(
        overlay,
        applyTextKey(overlay.query, resolved) ?? overlay.query
      );
    } else {
      overlay.prompt.value = applyTextKey(overlay.prompt.value, resolved)
        ?? overlay.prompt.value;
    }
  }
  else if (resolved.action === "new-item") await createNewStory(state, source, context, overlay);
  else if (resolved.action === "open-selected" && overlay.prompt !== null) {
    await submitPrompt(state, source, context, overlay);
  } else if (resolved.action === "open-selected" && selected !== undefined) {
    await context.backend.run("loading story", async (task) => {
      const payload = await source.api.loadStory(selected.id);
      if (task.interactionCurrent() && state.library === overlay) {
        flushReadingPositionPersist();
        adoptStory(state, payload, context);
      }
    });
  }
  return true;
}

type LibraryOverlay = NonNullable<RuntimeState["library"]>;

export async function createNewStory(
  state: RuntimeState,
  source: AppSource,
  context: ActionContext,
  overlay: LibraryOverlay | null = null
): Promise<void> {
  await context.backend.run("creating story", async (task) => {
    const payload = await source.api.createStory();
    if (!task.storyCurrent()) return;
    let adopted = false;
    if (overlay === null && (task.interactionCurrent() || isPlainNavigation(state))) {
      adoptStory(state, payload, context);
      adopted = true;
    } else if (overlay === null && canCarryInteractionToNewStory(state)) {
      adoptReconciliationSnapshot(state, payload, context.cache);
      adopted = true;
    } else if (overlay !== null && task.interactionCurrent() && state.library === overlay) {
      adoptStory(state, payload, context);
      adopted = true;
    }
    if (adopted) {
      context.repaint();
    }
    if (!task.owns()) return;
    const stories = await source.api.listStories();
    if (task.owns()) {
      publishStories(state, source, stories);
      if (!adopted) state.toast = "new story created · current work kept · open it from the library";
    }
  });
}

/** Different-story reconciliation knows how to carry only these global or
 * draft-owning surfaces. Story-bound editors and confirmations stay put. */
function canCarryInteractionToNewStory(state: RuntimeState): boolean {
  return state.mode === "COMPOSE"
    || state.mode === "LIBRARY"
    || state.mode === "SETTINGS"
    || globalEditor(state) !== null
    || state.mode === "COMMANDS"
    || state.mode === "KEYS";
}

async function submitPrompt(
  state: RuntimeState,
  source: AppSource,
  context: ActionContext,
  overlay: LibraryOverlay
): Promise<void> {
  const prompt = overlay.prompt!;
  if (prompt.kind === "filter") {
    overlay.cursor = boundedLibraryCursor(
      overlay.cursor,
      libraryRows(overlay.stories, overlay.query).length
    );
    overlay.prompt = null;
    return;
  }
  const target = overlay.stories.find((story) => story.id === prompt.targetId);
  if (target === undefined) {
    if (overlay.prompt === prompt) overlay.prompt = null;
    state.toast = "story changed · action cancelled";
    return;
  }
  if (prompt.kind === "rename") {
    await renameStory(state, source, context, overlay, prompt, target);
  } else {
    await deleteStory(state, source, context, overlay, prompt, target);
  }
}

async function renameStory(
  state: RuntimeState,
  source: AppSource,
  context: ActionContext,
  overlay: LibraryOverlay,
  prompt: Extract<NonNullable<LibraryOverlay["prompt"]>, { kind: "rename" }>,
  target: AppSource["stories"][number]
): Promise<void> {
  const title = prompt.value.trim();
  if (title.length === 0) return void (state.toast = "story title required");
  await context.backend.run("renaming story", async (task) => {
    const payload = await source.api.renameStory(target.id, title);
    if (!task.storyCurrent()) return;
    if (target.id === task.storyId) {
      adoptSameStoryPayload(state, payload, context.cache);
    }
    if (state.library === overlay && overlay.prompt === prompt && prompt.value.trim() === title) {
      overlay.prompt = null;
      state.toast = `renamed ${title}`;
    }
    if (!task.owns()) return;
    const stories = await source.api.listStories();
    if (task.owns()) publishStories(state, source, stories);
  });
}

async function deleteStory(
  state: RuntimeState,
  source: AppSource,
  context: ActionContext,
  overlay: LibraryOverlay,
  prompt: Extract<NonNullable<LibraryOverlay["prompt"]>, { kind: "delete" }>,
  target: AppSource["stories"][number]
): Promise<void> {
  if (!typedTitleMatches(target.title, prompt.value)) return void (state.toast = "title does not match · story kept");
  await context.backend.run("deleting story", async (task) => {
    const deletedOpenStory = target.id === task.storyId;
    await source.api.deleteStory(target.id);
    if (!task.owns()) return;
    forgetStoryReadingPosition(state, source, target.id);
    let stories = await source.api.listStories();
    if (!task.owns()) return;
    if (deletedOpenStory && task.storyCurrent()) {
      const fallback = stories[0];
      const next = fallback === undefined
        ? await source.api.createStory()
        : await source.api.loadStory(fallback.id);
      if (!task.owns()) return;
      if (fallback === undefined) {
        stories = await source.api.listStories();
        if (!task.owns()) return;
      }
      publishStories(state, source, stories);
      if (task.interactionCurrent()) adoptStoryState(state, next, context.cache);
      else {
        adoptReconciliationSnapshot(state, next, context.cache,
          state.library === overlay && overlay.prompt === prompt
            ? { discardedLibrary: overlay }
            : {});
      }
      state.toast = `deleted ${target.title}`;
      return;
    }
    publishStories(state, source, stories);
    if (state.library === overlay && overlay.prompt === prompt) {
      overlay.prompt = null;
      state.toast = `deleted ${target.title}`;
    }
  });
}

function adoptStory(state: RuntimeState, payload: RuntimeState["payload"], context: ActionContext): void {
  adoptStoryState(state, payload, context.cache);
}
