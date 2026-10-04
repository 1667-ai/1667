import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  SEARCH_DEBOUNCE_MS,
  boundedSearchCursor,
  firstHitCursor,
  previewSearchHit,
  searchRows,
  selectedSearchRow,
  type SearchGroupRow,
  type SearchHitRow,
  type SearchState
} from "../../../shared/search-model.js";
import { createStoryIndex } from "../../../shared/story-model.js";
import { searchQueryIsRunnable, SEARCH_MIN_QUERY, type SearchHit, type SearchResponse, type SearchScope } from "../../../shared/story-search.js";
import type { StoryPayload } from "../../../shared/types.js";
import { useAppContext } from "../app/context.js";
import { useStore } from "../app/store.js";
import { Icon, ICONS } from "../ui/icons.js";
import { Modal } from "../ui/Modal.js";
import { openSearchHit } from "./open-hit.js";
import { resolveSearchBinding } from "./search-keys.js";

const HINT = `Type at least ${SEARCH_MIN_QUERY} characters to search.`;

function Marked({ text, at, length }: { readonly text: string; readonly at: number; readonly length: number }): ReactNode {
  return (
    <>
      {text.slice(0, at)}
      <mark className="search-match">{text.slice(at, at + length)}</mark>
      {text.slice(at + length)}
    </>
  );
}

function hitRef(hit: SearchHit): string {
  if (hit.kind === "fact") return "fact";
  return `${hit.kind === "prompt" ? "»" : "¶"}${hit.depth}`;
}

/** Where the previewed hit lives: story (vault), part, take and tag. */
function previewDetail(hit: SearchHit, payload: StoryPayload, scope: SearchScope): string {
  const story = scope === "vault" && hit.storyId !== payload.id ? `${hit.storyTitle} · ` : "";
  if (hit.kind === "fact") return `${story}fact`;
  const where = `${hit.kind === "prompt" ? "prompt of ¶" : "¶ "}${hit.depth}`;
  if (hit.storyId !== payload.id) return `${story}${where}`;
  const index = createStoryIndex(payload);
  const position = index.tree.siblingPositionByNodeId.get(hit.targetId);
  const take = position === undefined ? "" : ` · take ${position.index}/${position.count}`;
  const tag = index.tagByNodeId.get(hit.targetId);
  return `${story}${where}${take}${tag === undefined ? "" : ` · ${tag.name}`}`;
}

/**
 * `/`: full-text search of this story or the whole vault (the TUI's SEARCH
 * mode). Typing searches after a short pause; Tab switches scope; Ctrl+S or
 * the Aa button matches case; ↑ ↓ move; ← and → fold a group when the caret is
 * at the edge of the query; Enter opens the hit. A new request stops the
 * one it replaces.
 */
export function SearchDialog({ onClose }: { readonly onClose: () => void }) {
  const { store, actions } = useAppContext();
  const story = useStore(store, (state) => state.story);
  const stories = useStore(store, (state) => state.library.stories);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<SearchScope>("tree");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [folded, setFolded] = useState<readonly string[]>([]);
  const [opening, setOpening] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  // Typing waits for a pause; a scope or case change is one deliberate act and does not.
  const delayRef = useRef(SEARCH_DEBOUNCE_MS);
  const payload = story.kind === "loaded" ? story.payload : null;
  const storyId = payload?.id ?? null;
  const trimmed = query.trim();
  const runnable = searchQueryIsRunnable(trimmed);

  useEffect(() => {
    setResponse(null);
    setError(null);
    setCursor(0);
    const connection = store.get().connection;
    if (!runnable || storyId === null || connection.kind !== "connected") {
      setWaiting(false);
      return;
    }
    setWaiting(true);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      connection.api.searchStories({ query: trimmed, scope, storyId, caseSensitive }, controller.signal).then((next) => {
        if (controller.signal.aborted) return;
        setWaiting(false);
        setResponse(next);
      }, (failure: unknown) => {
        if (controller.signal.aborted) return;
        setWaiting(false);
        setError(failure instanceof Error ? failure.message : String(failure));
      });
    }, delayRef.current);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [trimmed, runnable, scope, caseSensitive, storyId, store]);

  const search: SearchState | null = useMemo(() => (
    payload === null ? null : {
      query, scope, caseSensitive, response, pending: null, scheduled: null, cursor,
      foldedGroupIds: folded, stories: stories ?? [], error
    }
  ), [payload, query, scope, caseSensitive, response, cursor, folded, stories, error]);
  const model = useMemo(
    () => (search === null || payload === null ? null : searchRows(search, payload)),
    [search, payload]
  );

  // A fresh result set puts the cursor on its first hit, not the header above it.
  useEffect(() => {
    if (response !== null && model !== null) setCursor(firstHitCursor(model));
    // Only when a new response lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [response]);

  const active = model === null ? 0 : boundedSearchCursor(cursor, model.selectableCount);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active, response]);

  if (payload === null || model === null) return null;
  const preview = previewSearchHit(model, active);

  const toggleFold = (groupId: string, fold: boolean): void =>
    setFolded((current) => fold
      ? (current.includes(groupId) ? current : [...current, groupId])
      : current.filter((id) => id !== groupId));

  const changeScope = (next: SearchScope): void => {
    delayRef.current = 0;
    setScope(next);
  };
  const toggleCase = (): void => {
    delayRef.current = 0;
    setCaseSensitive((current) => !current);
  };

  const activate = (row: SearchGroupRow | SearchHitRow | null): void => {
    if (row === null || opening) return;
    if (row.kind === "group") {
      toggleFold(row.id, !folded.includes(row.id));
      return;
    }
    setOpening(true);
    void openSearchHit(row.hit, store, actions, onClose).finally(() => setOpening(false));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing) return;
    const binding = resolveSearchBinding(event.nativeEvent);
    if (binding === null) return;
    const input = event.currentTarget;
    const caretStart = input.selectionStart === 0 && input.selectionEnd === 0;
    const caretEnd = input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
    switch (binding.action) {
      case "focus-next":
      case "focus-previous":
        event.preventDefault();
        setCursor(boundedSearchCursor(active + (binding.action === "focus-next" ? 1 : -1), model.selectableCount));
        return;
      case "take-previous":
      case "take-next": {
        const folding = binding.action === "take-previous";
        if (folding ? !caretStart : !caretEnd) return;
        const row = selectedSearchRow(model, active);
        if (row === null) return;
        event.preventDefault();
        const groupId = row.kind === "group" ? row.id : row.groupId;
        if (folding && row.kind === "hit") {
          // Land on the header that now stands for the hidden rows.
          const header = model.rows.find((candidate): candidate is SearchGroupRow & { select: number } =>
            candidate.kind === "group" && candidate.id === groupId);
          if (header !== undefined) setCursor(header.select);
        }
        toggleFold(groupId, folding);
        return;
      }
      case "cycle":
        if (event.shiftKey) return;
        event.preventDefault();
        changeScope(scope === "tree" ? "vault" : "tree");
        return;
      case "toggle-search-case":
        event.preventDefault();
        toggleCase();
        return;
      case "apply":
        event.preventDefault();
        activate(selectedSearchRow(model, active));
        return;
      default:
    }
  };

  let status: string;
  if (error !== null) status = `Search failed: ${error}`;
  else if (!runnable) status = HINT;
  else if (waiting || response === null) status = "Searching…";
  else if (response.hits.length === 0) status = "No matches.";
  else {
    const hits = response.hits.length;
    status = `${hits} ${hits === 1 ? "hit" : "hits"}${response.capped ? " (first results only; narrow the query)" : ""}`;
  }

  return (
    <Modal onCancel={onClose} ariaLabel="Search" className="search-modal">
      <div className="search-bar">
        <div className="search-field">
          <Icon path={ICONS.search} />
          <input
            ref={inputRef}
            type="text"
            className="search-input"
            role="combobox"
            aria-label="Search text"
            aria-expanded="true"
            aria-controls={listId}
            placeholder={scope === "tree" ? "Search this story" : "Search all stories"}
            autoComplete="off"
            spellCheck={false}
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            value={query}
            onChange={(event) => { delayRef.current = SEARCH_DEBOUNCE_MS; setQuery(event.currentTarget.value); }}
            onKeyDown={onKeyDown}
          />
        </div>
        <div className="search-toggles" role="group" aria-label="Search options">
          <button
            type="button"
            className="chip-btn"
            aria-pressed={scope === "tree"}
            title="Search this story (Tab)"
            onClick={() => changeScope("tree")}
          >This story</button>
          <button
            type="button"
            className="chip-btn"
            aria-pressed={scope === "vault"}
            title="Search all stories (Tab)"
            onClick={() => changeScope("vault")}
          >All stories</button>
          <button
            type="button"
            className="chip-btn search-case"
            aria-pressed={caseSensitive}
            aria-label="Match case"
            title="Match case (Ctrl+S)"
            onClick={toggleCase}
          >Aa</button>
        </div>
      </div>
      <p className="search-status" role="status">{status}</p>
      <div className="search-body">
        <div id={listId} ref={listRef} className="search-list" role="listbox" aria-label="Search results">
          {model.rows.map((row, position) => {
            if (row.kind === "blank") return null;
            const selected = row.select === active;
            if (row.kind === "group") {
              const count = row.hits.length;
              return (
                <div
                  key={`group-${row.id}`}
                  role="option"
                  aria-selected={selected}
                  aria-expanded={!row.folded}
                  className={`search-group${selected ? " search-row-active" : ""}`}
                  onMouseMove={() => setCursor(row.select)}
                  onClick={() => activate(row)}
                >
                  <Icon path={row.folded ? ICONS.chevronRight : ICONS.chevronDown} />
                  <span className="search-group-name">{row.name}</span>
                  {row.detail.length > 0 && <span className="search-detail">{row.detail}</span>}
                  <span className="search-count">{count} {count === 1 ? "hit" : "hits"}</span>
                </div>
              );
            }
            return (
              <div
                key={`hit-${position}`}
                role="option"
                aria-selected={selected}
                className={`search-hit${selected ? " search-row-active" : ""}`}
                onMouseMove={() => setCursor(row.select)}
                onClick={() => activate(row)}
              >
                <span className="search-ref">{hitRef(row.hit)}</span>
                <span className="search-snippet">
                  <Marked text={row.hit.snippet} at={row.hit.snippetMatch} length={row.hit.matchLength} />
                </span>
              </div>
            );
          })}
        </div>
        <div className="search-preview" aria-label="Preview">
          {preview !== null && (
            <>
              <p className="search-preview-detail">{previewDetail(preview.hit, payload, scope)}</p>
              <p className="search-preview-text">
                <Marked text={preview.hit.context} at={preview.hit.contextMatch} length={preview.hit.matchLength} />
              </p>
            </>
          )}
        </div>
      </div>
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" title="Close (Esc)" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}
