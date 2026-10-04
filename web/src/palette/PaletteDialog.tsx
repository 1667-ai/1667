import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useAppContext } from "../app/context.js";
import { useStore } from "../app/store.js";
import { Modal } from "../ui/Modal.js";
import { paletteGroups, type CommandMatch } from "./model.js";
import { registeredCommands, type CommandContext } from "./registry.js";

function Title({ match }: { readonly match: CommandMatch }) {
  const marked = new Set(match.indices);
  return (
    <span className="menu-item-text">
      {[...match.command.title].map((character, index) => (
        marked.has(index) ? <mark key={index} className="palette-hit">{character}</mark> : character
      ))}
    </span>
  );
}

/**
 * `:`: type to narrow, ↑ ↓ to move, Enter to run, Esc to close. The commands
 * come from the registry (`palette/registry.ts`); this dialog names none of
 * them. The command runs after the dialog has closed, so focus has already
 * gone back to where it was and a command that moves focus wins.
 */
export function PaletteDialog({ onClose, openLibrary }: { readonly onClose: () => void; readonly openLibrary: () => void }) {
  const { store, actions } = useAppContext();
  const state = useStore(store, (current) => current);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const context: CommandContext = { store, state, actions, openLibrary };
  // The commands do not change while the palette is open; the state they read does.
  const groups = useMemo(
    () => paletteGroups(registeredCommands(), query, context),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query, state]
  );
  const flat = groups.flatMap((group) => group.matches);
  const active = Math.min(cursor, Math.max(0, flat.length - 1));

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active, query]);

  const run = (match: CommandMatch | undefined): void => {
    if (match === undefined) return;
    onClose();
    const latest: CommandContext = { store, state: store.get(), actions, openLibrary };
    setTimeout(() => match.command.run(latest), 0);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (flat.length === 0) return;
      setCursor((active + (event.key === "ArrowDown" ? 1 : flat.length - 1)) % flat.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      run(flat[active]);
    }
  };

  let position = -1;
  return (
    <Modal onCancel={onClose} ariaLabel="Command palette" className="palette-modal">
      <input
        type="text"
        className="palette-input"
        role="combobox"
        aria-label="Command"
        aria-expanded="true"
        aria-controls={listId}
        aria-activedescendant={flat.length === 0 ? undefined : `${listId}-${active}`}
        placeholder="Type a command"
        autoComplete="off"
        spellCheck={false}
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        value={query}
        onChange={(event) => { setQuery(event.currentTarget.value); setCursor(0); }}
        onKeyDown={onKeyDown}
      />
      <div id={listId} ref={listRef} className="palette-list" role="listbox" aria-label="Commands">
        {groups.map((group) => (
          <div key={group.id} role="group" aria-label={group.label}>
            <div className="menu-heading" aria-hidden="true">{group.label}</div>
            {group.matches.map((match) => {
              position += 1;
              const index = position;
              return (
                <div
                  key={match.command.id}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === active}
                  className={`menu-item palette-item${index === active ? " palette-item-active" : ""}`}
                  onMouseMove={() => setCursor(index)}
                  onClick={() => run(match)}
                >
                  <Title match={match} />
                  {match.command.shortcut !== undefined && <span className="menu-key">{match.command.shortcut}</span>}
                </div>
              );
            })}
          </div>
        ))}
        {flat.length === 0 && <p className="palette-empty">No command matches.</p>}
      </div>
    </Modal>
  );
}
