import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { TAG_STATUSES, type StoryPayload, type TagStatus } from "../../../shared/types.js";
import { lineName } from "../../../shared/story-model.js";
import { useAppContext } from "../app/context.js";
import { useStore } from "../app/store.js";
import { Icon, ICONS } from "../ui/icons.js";
import { StatusChip } from "./StatusChip.js";
import { tagDraftOf, tagOf, type TagTarget } from "./state.js";

const statusLabel = (status: TagStatus): string => (status.length === 0 ? "None" : status);

/**
 * The tag popover: name the line, give it a status, save it, and — below —
 * every tagged line of the story, each with a two-click delete. It uses the
 * one menu look (`styles/menu.css`) and owns its keys, so letters type. Esc
 * is closed by `usePopover` in `LineChip`; the draft stays in the store.
 */
export function TagPopover({ payload, target }: { readonly payload: StoryPayload; readonly target: TagTarget }) {
  const { store, actions } = useAppContext();
  const tags = useStore(store, (state) => state.tags);
  const nameRef = useRef<HTMLInputElement>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  useEffect(() => {
    nameRef.current?.focus();
    nameRef.current?.select();
  }, []);

  const draft = tagDraftOf(tags, payload, target);
  const existing = tagOf(payload, target.nodeId);
  const activeLeafId = payload.path.at(-1)?.id ?? null;

  // Enter saves from the name and from a status (Space picks a status).
  const onFormKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement;
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    if (target.tagName !== "INPUT" && target.getAttribute("role") !== "radio") return;
    event.preventDefault();
    void actions.tags.save();
  };

  return (
    <div className="menu tag-popover" role="dialog" aria-label="Tag line" data-owns-keys>
      <div className="tag-form" onKeyDown={onFormKeyDown}>
        <label className="tag-label" htmlFor="tag-name">Name</label>
        <input
          id="tag-name"
          ref={nameRef}
          className="tag-input"
          value={draft.name}
          placeholder={lineName(payload, target.nodeId)}
          disabled={tags.busy}
          onChange={(event) => actions.tags.setName(event.target.value)}
        />
        <div className="tag-statuses" role="radiogroup" aria-label="Status">
          {TAG_STATUSES.map((status) => (
            <button
              key={status || "none"}
              type="button"
              role="radio"
              aria-checked={draft.status === status}
              className="tag-status"
              disabled={tags.busy}
              onClick={() => actions.tags.setStatus(status)}
            >
              {statusLabel(status)}
            </button>
          ))}
        </div>
        <div className="tag-actions">
          {existing !== null && (
            <button
              type="button"
              className="btn btn-small btn-danger"
              disabled={tags.busy}
              title="Remove tag"
              onClick={() => { void actions.tags.remove(target.nodeId); }}
            >
              Remove
            </button>
          )}
          <button
            type="button"
            className="btn btn-small btn-primary"
            disabled={tags.busy}
            title="Save (Enter)"
            onClick={() => { void actions.tags.save(); }}
          >
            Save
          </button>
        </div>
      </div>
      {payload.tags.length > 0 && (
        <>
          <div className="menu-heading">Tagged lines ({payload.tags.length})</div>
          <ul className="tag-list">
            {payload.tags.map((tag) => (
              <li key={tag.nodeId} className={`tag-row${tag.nodeId === activeLeafId ? " current" : ""}`}>
                <StatusChip status={tag.status} />
                <span className="tag-row-name" title={tag.name}>{tag.name}</span>
                {confirming === tag.nodeId
                  ? (
                    <button
                      type="button"
                      className="btn btn-small btn-danger"
                      autoFocus
                      title="Confirm delete"
                      onBlur={() => setConfirming(null)}
                      onClick={() => { setConfirming(null); void actions.tags.remove(tag.nodeId); }}
                    >
                      Confirm
                    </button>
                  )
                  : (
                    <button
                      type="button"
                      className="icon-btn"
                      title="Delete tag"
                      aria-label="Delete tag"
                      onClick={() => setConfirming(tag.nodeId)}
                    >
                      <Icon path={ICONS.trash} />
                    </button>
                  )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
