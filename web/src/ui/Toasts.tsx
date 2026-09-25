import type { Toast } from "../app/state.js";
import { Icon, ICONS } from "./icons.js";

/** `.toast` is `.loom-toast` ported from `~/source/storytavern/web/src/loom.css`
 * and renamed (`styles/toast.css`); this stacks several, which the original
 * single-instance overlay never had to. */
export function ToastStack(
  { toasts, onDismiss }: {
    readonly toasts: readonly Toast[];
    readonly onDismiss: (id: string) => void;
  }
) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className="toast">
          <span>{toast.message}</span>
          <button
            type="button"
            className="icon-btn toast-close"
            aria-label="Dismiss"
            onClick={() => onDismiss(toast.id)}
          >
            <Icon path={ICONS.x} />
          </button>
        </div>
      ))}
    </div>
  );
}
