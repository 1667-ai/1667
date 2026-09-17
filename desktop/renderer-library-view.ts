import type { StoryPayload, StorySummary } from "../shared/types.js";
import type { SearchHit } from "../shared/story-search.js";
import { actionButton, bindDraftInput, el } from "./renderer-dom.js";
import {
  visibleStories,
  type RendererActions,
  type RendererState
} from "./renderer-model.js";

/** Library destination (⌘1): find or start a story, then the STORY and
 * PROJECT sections that used to live in the topbar and the story header. */
export function renderLibraryDestination(state: RendererState, actions: RendererActions): HTMLElement {
  const library = el("div", "library");
  const heading = el("div", "section-heading");
  heading.append(
    actionButton("new-story-button", "+ new story", actions.createStory),
    actionButton("library-import", "Import", actions.importMarkdown)
  );
  const search = document.createElement("input");
  search.className = "library-search";
  search.type = "search";
  search.placeholder = "Find a story";
  search.value = state.search;
  search.dataset.preserve = "search";
  search.setAttribute("aria-label", "Find a story");
  bindDraftInput(search, () => actions.setSearch(search.value));
  library.append(heading, search);
  const visible = visibleStories(state);
  const list = el("div", "story-list");
  for (const story of visible) list.append(renderStoryRow(story, state.story?.id === story.id, actions));
  library.append(list);
  if (state.stories.length === 0) {
    library.append(el("div", "welcome", el("span", "eyebrow", "No story open"), el("h1", "", "Make a place for the next sentence."), el("p", "", "Create a story to begin.")));
  } else if (visible.length === 0) {
    library.append(el("p", "empty-copy", "No stories match this search."));
  }
  if (state.searchBusy) library.append(el("p", "library-hint", "Searching the vault…"));
  if (state.searchHits.length > 0) library.append(renderSearchResults(state.searchHits, actions));
  if (state.story !== null) library.append(renderStorySection(state.story, actions));
  library.append(renderProjectSection(state, actions));
  return library;
}

function renderStoryRow(story: StorySummary, active: boolean, actions: RendererActions): HTMLElement {
  const row = el("button", `story-row ${active ? "active" : ""}`);
  row.type = "button";
  row.dataset.preserve = `story-row:${story.id}`;
  row.addEventListener("click", () => actions.selectStory(story.id));
  row.append(
    el("span", "story-row-title", story.title),
    el("span", "story-row-meta", `${story.words.toLocaleString()} words · ${story.partCount} part${story.partCount === 1 ? "" : "s"}`),
    story.forked ? el("span", "story-row-mark", "forked") : ""
  );
  return row;
}

function renderSearchResults(hits: readonly SearchHit[], actions: RendererActions): HTMLElement {
  const results = el("div", "search-results", el("span", "eyebrow", "Matches"));
  for (const hit of hits.slice(0, 12)) {
    const button = actionButton("search-result", "", () => actions.openSearchHit(hit));
    button.dataset.preserve = `search-result:${hit.storyId}:${hit.kind}:${hit.targetId}:${hit.stateId ?? ""}`;
    button.append(el("strong", "search-result-title", `${hit.storyTitle} · ${hit.kind}`), el("span", "search-result-snippet", hit.snippet));
    results.append(button);
  }
  if (hits.length > 12) results.append(el("p", "library-hint", `${hits.length - 12} more matches`));
  return results;
}

function renderStorySection(story: StoryPayload, actions: RendererActions): HTMLElement {
  const section = el("section", "library-section");
  section.append(el("span", "eyebrow", "Story"));
  const buttons = el("div", "library-section-actions");
  buttons.append(
    actionButton("rename-story", "Rename", actions.renameStory),
    actionButton("autoname-story", "Autoname", actions.autonameStory),
    actionButton("export-story", "Export", actions.exportMarkdown),
    actionButton("export-archive", "Export archive", () => { void exportArchive(story.id, actions); }),
    actionButton("import-archive", "Import archive", () => { void importArchive(actions); }),
    actionButton("import-card", "Import card", actions.importCard),
    actionButton("import-lorebook", "Import lorebook", actions.importLorebook),
    actionButton("delete-story", "Delete story…", actions.deleteStory, "Delete this story")
  );
  section.append(buttons);
  if (story.tags.length > 0) {
    const tagged = el("div", "library-tagged-lines");
    tagged.append(el("span", "eyebrow", "Tagged lines"));
    const chips = el("div", "library-section-actions");
    for (const tag of story.tags) {
      const chip = actionButton("line-tag", `${tag.status || "tag"} · ${tag.name}`, () => actions.switchToTaggedLine(tag.name, tag.nodeId), "Open tagged line");
      chip.dataset.preserve = `line-tag:${tag.nodeId}`;
      chips.append(chip);
    }
    tagged.append(chips);
    section.append(tagged);
  }
  return section;
}

function renderProjectSection(state: RendererState, actions: RendererActions): HTMLElement {
  const section = el("section", "library-section");
  section.append(el("span", "eyebrow", "Project"));
  if (state.project !== null) section.append(el("p", "project-path", state.project.root));
  const buttons = el("div", "library-section-actions");
  buttons.append(actionButton("project-reveal", "Reveal folder", actions.revealProject));
  buttons.append(actionButton("project-browser", "Projects", () => actions.showProjects(true)));
  if (state.project?.open === true) {
    buttons.append(
      state.project.vault === "sealed"
        ? actionButton("project-unseal", "Unseal", actions.unsealProject)
        : actionButton("project-seal", "Seal", actions.sealProject)
    );
  }
  buttons.append(actionButton("refresh-button", "Refresh library", actions.refresh));
  section.append(buttons);
  return section;
}

async function importArchive(actions: RendererActions): Promise<void> {
  const response = await actions.shellRequest({ type: "dialog.open", kind: "story-import" });
  if (!response.ok || response.result.type !== "dialog" || response.result.paths[0] === undefined) return;
  await actions.shellRequest({ type: "story.import", file: response.result.paths[0] });
}

async function exportArchive(storyId: string, actions: RendererActions): Promise<void> {
  const response = await actions.shellRequest({ type: "dialog.directory" });
  if (!response.ok || response.result.type !== "dialog" || response.result.paths[0] === undefined) return;
  await actions.shellRequest({ type: "story.export", directory: response.result.paths[0], storyId, all: false, format: "story", force: false });
}
