import { useEffect, useRef } from "react";
import { useAppContext } from "../app/context.js";
import { useStore } from "../app/store.js";
import { Modal } from "../ui/Modal.js";

function plural(count: number, word: string): string {
  return `${count.toLocaleString("en-US")} ${word}${count === 1 ? "" : "s"}`;
}

/**
 * The Fact check's confirmation: what the check will read and how many model
 * requests it will send. Cancel runs nothing. Once the check runs, it cannot
 * be stopped, so this is the last point to back out (as in the TUI).
 */
export function FactCheckDialog() {
  const { store, actions } = useAppContext();
  const confirm = useStore(store, (state) => state.factCheck.confirm);
  const checkRef = useRef<HTMLButtonElement>(null);
  const plan = confirm?.plan ?? null;

  useEffect(() => {
    if (plan !== null && plan.partCount > 0) checkRef.current?.focus();
  }, [plan]);

  if (confirm === null) return null;
  const what = confirm.scope === "chapter" ? "chapter" : "story line";
  const nothing = plan !== null && plan.partCount === 0;

  return (
    <Modal onCancel={actions.factCheck.cancel} ariaLabel={`Check ${what} against Facts`}>
      <form
        className="modal-form"
        method="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          void actions.factCheck.confirm();
        }}
      >
        <h2>Check {what} against Facts</h2>
        <p className="modal-status" role="status">
          {plan === null
            ? "Counting the parts…"
            : nothing
            ? "No part has a Fact that applies. There is nothing to check."
            : `This check reads ${plural(plan.partCount, "part")} and sends ${plural(plan.requestCount, "request")} to the model. It does not change the story.`}
        </p>
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" title="Cancel (Esc)" onClick={actions.factCheck.cancel}>Cancel</button>
          <button ref={checkRef} type="submit" className="btn btn-primary" disabled={plan === null || nothing}>Check</button>
        </div>
      </form>
    </Modal>
  );
}
