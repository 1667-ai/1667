import { useState, type KeyboardEvent } from "react";
import type { StoryPayload } from "../../../shared/types.js";
import { useAppContext } from "../app/context.js";
import { useStore } from "../app/store.js";

/** The story's facts budget: a line that opens a number field. Enter saves, an
 * empty field clears the budget, Esc leaves it as it was. */
export function FactsBudget({ payload }: { readonly payload: StoryPayload }) {
  const { store, actions } = useAppContext();
  const busy = useStore(store, (state) => state.facts.busy);
  const [text, setText] = useState<string | null>(null);
  const budget = payload.factsBudgetTokens;

  if (text === null) {
    return (
      <button
        type="button"
        className="btn btn-ghost btn-small facts-budget"
        title="Set the facts budget"
        onClick={() => setText(budget === undefined ? "" : String(budget))}
      >
        {budget === undefined ? "No facts budget" : `Facts budget: ${budget.toLocaleString()} tokens`}
      </button>
    );
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setText(null);
    } else if (event.key === "Enter") {
      event.preventDefault();
      void actions.facts.setBudget(text).then((saved) => { if (saved) setText(null); });
    }
  };

  return (
    <input
      className="facts-input facts-budget-input"
      inputMode="numeric"
      aria-label="Facts budget in tokens"
      placeholder="Tokens, empty for none"
      value={text}
      disabled={busy}
      autoFocus
      onChange={(event) => setText(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => setText(null)}
    />
  );
}
