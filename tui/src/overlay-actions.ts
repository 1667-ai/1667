import { access, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  commandContext,
  commandMatches,
  retainCommandSelection,
  type CommandMatch,
  type PaletteCommand
} from "./command-model.js";
import { connectionFailed, connectionSucceeded } from "./connection.js";
import { boundedFactCursor, boundedFactSelection, factRows, factTags } from "./facts-model.js";
import { applyTextKey, type ResolvedKey } from "./keys.js";
import { openFactEditor } from "./editor-action.js";
import { generationBusy, openBookmark, runPartAction } from "./story-actions.js";
import { openDirectComposer } from "./composer-ownership.js";
import { createUnusedTakesPrunePlan } from "./prune-model.js";
import { chaptersAction, createBreakAtFocus, openChapters } from "./chapter-actions.js";
import { createStoryViewModel, lastPartRowIndex } from "./model.js";
import { adoptSameStoryPayload } from "./story-adoption.js";
import { cancelSummary, startSummary } from "./summary-action.js";
import { libraryAction, openLibrary } from "./library-actions.js";
import { publishStories } from "./overlay-publication.js";
import { retryBackendState } from "./recovery-orchestration.js";
import {
  openSettingsOverlay,
  settingsOverlayAction
} from "./settings-overlay-actions.js";

import type { AppSource } from "./app.js";
import type { RuntimeState } from "./state.js";
import type { ActionContext } from "./action-context.js";

export type OverlayActionContext = ActionContext;

export async function handleOverlayAction(
  resolved: ResolvedKey,
  state: RuntimeState,
  source: AppSource,
  context: OverlayActionContext
): Promise<boolean> {
  if (resolved.action === "retry") { await reconnect(state, source, context); return true; }
  if (resolved.action === "open-library") { await openLibrary(state, source, context); return true; }
  if (resolved.action === "open-facts") {
    state.facts = initialFacts();
    if (resolved.index !== undefined) {
      const cursor = Math.max(0, Math.min(state.payload.facts.length - 1, resolved.index));
      state.facts.cursor = cursor;
      state.facts.expandedId = state.payload.facts[cursor]?.id ?? null;
    }
    state.mode = "FACTS";
    return true;
  }
  if (resolved.action === "open-commands") {
    state.commands = {
      query: "",
      ...retainCommandSelection(liveCommandMatches(state, ""), null, 0),
      view: "commands"
    };
    state.mode = "COMMANDS";
    return true;
  }
  if (resolved.action === "open-settings") {
    await openSettingsOverlay(state, source, context, resolved.settingsRow);
    return true;
  }
  if (resolved.action === "open-chapters") { openChapters(state); return true; }
  if (state.mode === "LIBRARY" && state.library !== null) {
    const prompt = state.library.prompt;
    const needsBackend = resolved.action === "new-item"
      || (resolved.action === "open-selected" && (prompt === null || prompt.kind !== "filter"));
    if (needsBackend && generationBusy(state)) {
      state.toast = "stream running · esc stops it first";
      return true;
    }
    return await libraryAction(resolved, state, source, context);
  }
  if (state.mode === "FACTS" && state.facts !== null) return await factsAction(resolved, state, source, context);
  if (state.mode === "COMMANDS" && state.commands !== null) return await commandsAction(resolved, state, source, context);
  if (state.mode === "SETTINGS" && state.settings !== null) {
    return await settingsOverlayAction(resolved, state, source, context);
  }
  if (state.mode === "CHAPTERS" && state.chapters !== null) {
    await chaptersAction(resolved, state, source, context);
    return true;
  }
  if (state.mode === "SUMMARY" && state.summary !== null) {
    if (resolved.action === "cancel") {
      cancelSummary(state);
    }
    return true;
  }
  return false;
}

function initialFacts() {
  return { cursor: 0, query: "", chip: 0, selectedTag: null, filtering: false, expandedId: null, deleteArmedId: null };
}

async function factsAction(
  resolved: ResolvedKey,
  state: RuntimeState,
  source: AppSource,
  context: OverlayActionContext
): Promise<boolean> {
  const overlay = state.facts!;
  Object.assign(overlay, boundedFactSelection(state.payload.facts, overlay, overlay.query));
  const tags = factTags(state.payload.facts);
  const rows = factRows(state.payload.facts, overlay.selectedTag, overlay.query);
  const selected = rows[overlay.cursor];
  if (resolved.action === "cancel") {
    if (overlay.deleteArmedId !== null) overlay.deleteArmedId = null;
    else if (overlay.filtering) overlay.filtering = false;
    else { state.facts = null; state.mode = "NAV"; }
  } else if (resolved.action === "focus-next") overlay.cursor = boundedFactCursor(overlay.cursor + 1, rows.length);
  else if (resolved.action === "focus-index") overlay.cursor = boundedFactCursor(resolved.index ?? overlay.cursor, rows.length);
  else if (resolved.action === "focus-previous") overlay.cursor = boundedFactCursor(overlay.cursor - 1, rows.length);
  else if (resolved.action === "filter") overlay.filtering = true;
  else if (resolved.action === "cycle") {
    overlay.chip = resolved.index === undefined
      ? (overlay.chip + 1) % tags.length
      : Math.max(0, Math.min(tags.length - 1, resolved.index));
    overlay.selectedTag = tags[overlay.chip] ?? null;
    overlay.cursor = 0;
  }
  else if ((resolved.action === "backspace" || resolved.action === "input") && overlay.filtering) {
    overlay.query = applyTextKey(overlay.query, resolved) ?? overlay.query;
    Object.assign(overlay, boundedFactSelection(state.payload.facts, overlay, overlay.query));
  }
  else if (resolved.action === "open-selected" && overlay.filtering) overlay.filtering = false;
  else if (resolved.action === "open-selected" && selected !== undefined) overlay.expandedId = overlay.expandedId === selected.id ? null : selected.id;
  else if (resolved.action === "delete-item" && selected !== undefined) {
    if (overlay.deleteArmedId !== selected.id) { overlay.deleteArmedId = selected.id; state.toast = "delete this fact? · d confirms · esc keeps"; }
    else {
      await context.backend.run("deleting fact", async (task) => {
        const payload = await source.api.deleteFact(task.storyId, selected.id);
        if (!task.storyCurrent()) return;
        adoptSameStoryPayload(state, payload);
        if (state.facts === overlay) {
          if (overlay.deleteArmedId === selected.id) overlay.deleteArmedId = null;
          Object.assign(overlay, boundedFactSelection(payload.facts, overlay, overlay.query));
          state.toast = "fact deleted";
        }
      });
    }
  } else if ((resolved.action === "edit" && selected !== undefined) || resolved.action === "new-item") {
    openFactEditor(state, resolved.action === "new-item" ? null : selected!);
    if (state.facts === overlay) {
      Object.assign(overlay, boundedFactSelection(state.payload.facts, overlay, overlay.query));
    }
  }
  return true;
}

async function commandsAction(resolved: ResolvedKey, state: RuntimeState, source: AppSource, context: OverlayActionContext): Promise<boolean> {
  const overlay = state.commands!;
  if (overlay.view === "bookmarks") {
    if (resolved.action === "cancel") {
      overlay.view = "commands";
      Object.assign(overlay, retainCommandSelection(
        liveCommandMatches(state, overlay.query), overlay.selectedId, overlay.cursor
      ));
    }
    else if (resolved.action === "focus-next") overlay.cursor = Math.max(0,
      Math.min(state.payload.bookmarks.length - 1, overlay.cursor + 1));
    else if (resolved.action === "focus-index") overlay.cursor = Math.max(0, Math.min(state.payload.bookmarks.length - 1, resolved.index ?? overlay.cursor));
    else if (resolved.action === "focus-previous") overlay.cursor = Math.max(0, overlay.cursor - 1);
    else if (resolved.action === "delete-item") {
      const bookmark = state.payload.bookmarks[overlay.cursor];
      if (bookmark !== undefined) {
        await context.backend.run("deleting bookmark", async (task) => {
          const payload = await source.api.deleteBookmark(task.storyId, bookmark.nodeId);
          if (!task.storyCurrent()) return;
          adoptSameStoryPayload(state, payload);
          if (state.commands === overlay && overlay.view === "bookmarks") {
            state.toast = "bookmark deleted";
          }
        });
      }
    }
    return true;
  }
  let matches = liveCommandMatches(state, overlay.query);
  Object.assign(overlay, retainCommandSelection(matches, overlay.selectedId, overlay.cursor));
  if (resolved.action !== "open-selected") {
    state.unknownOutcomeAcknowledgementArmed = null;
  }
  if (resolved.action === "cancel") { state.commands = null; state.mode = "NAV"; }
  else if (resolved.action === "focus-next") selectCommand(overlay, matches, overlay.cursor + 1);
  else if (resolved.action === "focus-index") selectCommand(overlay, matches, resolved.index ?? overlay.cursor);
  else if (resolved.action === "focus-previous") selectCommand(overlay, matches, overlay.cursor - 1);
  else if (resolved.action === "backspace" || resolved.action === "input") {
    overlay.query = applyTextKey(overlay.query, resolved) ?? overlay.query;
    matches = liveCommandMatches(state, overlay.query);
    selectCommand(overlay, matches, 0);
  }
  else if (resolved.action === "open-selected") {
    const command = matches[overlay.cursor]?.command;
    if (command?.id !== "acknowledge-generation") {
      state.unknownOutcomeAcknowledgementArmed = null;
    }
    if (command !== undefined) await runCommand(command, state, source, context);
  }
  // Live theme preview: highlighting a theme command shows it immediately;
  // leaving the highlight (or the palette) reverts to the saved theme.
  if (state.commands !== null && state.commands.view === "commands") {
    const liveMatches = liveCommandMatches(state, state.commands.query);
    Object.assign(state.commands, retainCommandSelection(
      liveMatches, state.commands.selectedId, state.commands.cursor
    ));
    const highlighted = liveMatches[state.commands.cursor]?.command;
    context.previewTheme(highlighted?.id === "theme" ? highlighted.theme ?? null : null);
  } else {
    context.previewTheme(null);
  }
  return true;
}

async function runCommand(command: PaletteCommand, state: RuntimeState, source: AppSource, context: OverlayActionContext): Promise<void> {
  if (command.mutating === true && generationBusy(state)) {
    state.toast = "stream running · esc stops it first";
    return;
  }
  if (command.id === "bookmarks") { state.commands!.view = "bookmarks"; state.commands!.cursor = 0; return; }
  if (command.id === "acknowledge-generation") {
    await acknowledgeUnknownGeneration(state, source, context);
    return;
  }
  state.commands = null;
  state.mode = "NAV";
  if (command.id === "bookmark-line") openBookmark(state);
  else if (command.id === "switch-story") await openLibrary(state, source, context);
  else if (command.id === "rename-story") {
    const targetId = state.payload.id;
    const title = state.payload.title;
    await openLibrary(state, source, context, {
      selectedStoryId: targetId,
      prompt: { kind: "rename", value: title, targetId }
    });
  }
  else if (command.id === "direct-take") openDirectComposer(state);
  else if (command.id === "retake") await runPartAction("retake", state, source, context);
  else if (command.id === "export") {
    const title = state.payload.title;
    await context.backend.run("exporting story", async (task) => {
      const markdown = await source.api.exportMarkdown(task.storyId);
      if (!task.owns()) return;
      const path = await availablePath(safeFilename(title));
      if (!task.owns()) return;
      await writeFile(path, markdown, { encoding: "utf8", flag: "wx" });
      if (task.interactionCurrent()) state.toast = `exported ${path}`;
    });
  } else if (command.id === "summary") await startSummary(state, source, context);
  else if (command.id === "chapters") openChapters(state);
  else if (command.id === "chapter") {
    state.focusIndex = lastPartRowIndex(createStoryViewModel(state.payload));
    await createBreakAtFocus(state, source, context);
  }
  else if (command.id === "autoname") {
    await context.backend.run("naming story", async (task) => {
      const payload = await source.api.autonameStory(task.storyId);
      if (!task.storyCurrent()) return;
      adoptSameStoryPayload(state, payload);
      if (!task.owns()) return;
      const stories = await source.api.listStories();
      if (!task.owns()) return;
      publishStories(state, source, stories);
      if (task.interactionCurrent()) state.toast = `story named ${payload.title}`;
    });
  } else if (command.id === "prune") {
    const plan = createUnusedTakesPrunePlan(state.payload);
    if (plan === null) state.toast = "nothing to prune · every leaf is protected";
    else state.prune = plan;
  } else if (command.id === "prompts") { state.showInstructions = !state.showInstructions; state.toast = `directions ${state.showInstructions ? "shown" : "hidden"}`; }
  else if (command.id === "settings") await openSettingsOverlay(state, source, context);
  else if (command.id === "theme" && command.theme !== undefined) {
    context.applyTheme(command.theme);
    state.toast = `theme · ${command.theme}`;
  }
  else if (command.id === "reconnect") await reconnect(state, source, context);
  else if (command.id === "folder") state.toast = source.storyFolder;
  else if (command.id === "disconnect" && state.demo) {
    state.connection = connectionFailed(connectionSucceeded(), new Error("demo disconnect"), state.now);
    state.toast = "simulated connection loss";
  }
}

async function acknowledgeUnknownGeneration(
  state: RuntimeState,
  source: AppSource,
  context: OverlayActionContext
): Promise<void> {
  const pending = state.unknownOutcomes.find(
    ({ storyId }) => storyId === state.payload.id
  ) ?? state.unknownOutcomes[0];
  if (pending === undefined) {
    state.unknownOutcomeAcknowledgementArmed = null;
    state.toast = "no unknown provider outcome is waiting";
    return;
  }
  if (state.unknownOutcomeAcknowledgementArmed !== pending.mutationId) {
    state.unknownOutcomeAcknowledgementArmed = pending.mutationId;
    state.toast = `press enter again now · ${pending.storyId} may have been billed or completed`;
    return;
  }

  state.unknownOutcomeAcknowledgementArmed = null;
  state.commands = null;
  state.mode = "NAV";
  await context.backend.run("acknowledging provider outcome", async (task) => {
    const payload = await source.api.acknowledgeUnknownOutcomes(
      pending.storyId,
      pending.mutationId
    );
    if (!task.owns()) return;
    state.unknownOutcomes = state.unknownOutcomes.filter(
      ({ mutationId }) => mutationId !== pending.mutationId
    );
    if (payload !== null && state.payload.id === payload.id) {
      adoptSameStoryPayload(state, payload);
    }
    const stories = await source.api.listStories();
    if (!task.owns()) return;
    publishStories(state, source, stories);
    if (task.interactionCurrent()) {
      state.toast = "unknown provider outcome acknowledged · billing status unchanged";
    }
  });
}

function liveCommandMatches(state: RuntimeState, query: string): CommandMatch[] {
  return commandMatches(
    query,
    state.demo,
    commandContext(state.payload, state.connection.down, generationBusy(state) || state.summary !== null)
  );
}

function selectCommand(
  overlay: NonNullable<RuntimeState["commands"]>,
  matches: readonly CommandMatch[],
  cursor: number
): void {
  Object.assign(overlay, retainCommandSelection(matches, null, cursor));
}

async function reconnect(state: RuntimeState, source: AppSource, context: OverlayActionContext): Promise<void> {
  const connection = source.connection;
  if (connection === null) {
    state.connection = connectionSucceeded();
    state.toast = "reconnected · demo fixture";
    return;
  }
  await retryBackendState({
    state,
    source,
    backend: context.backend,
    invalidateCache: () => context.cache.invalidate(),
    repaint: context.repaint
  });
}

function safeFilename(title: string): string {
  let name = title.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim() || "story";
  // Stay well under the 255-byte filesystem component limit, leaving room
  // for the "-<n>.md" collision suffix.
  const encoder = new TextEncoder();
  while (encoder.encode(name).length > 120) name = [...name].slice(0, -1).join("").trimEnd();
  return name || "story";
}

/** Never clobber an existing export: story.md, story-2.md, story-3.md, … */
async function availablePath(base: string): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    const candidate = resolve(process.cwd(), attempt === 1 ? `${base}.md` : `${base}-${attempt}.md`);
    try {
      await access(candidate);
    } catch {
      return candidate;
    }
  }
}
