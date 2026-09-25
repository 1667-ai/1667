import { useEffect, useRef, type ReactNode } from "react";

/**
 * The shared `<dialog>` lifecycle (review fix C8) `RenameDialog` and
 * `DeleteDialog` both needed: `showModal()` on mount (the browser's own
 * focus trap and `::backdrop`), wiring the native `cancel` event (fires on
 * Escape) to `onCancel`, and `close()` on unmount if still open. `onCancel`
 * lives in a ref, updated every render, so the mount effect can read the
 * latest one without listing it as a dependency — that is what lets the
 * effect run exactly once, on mount only, with no
 * `react-hooks/exhaustive-deps` disable.
 */
export function Modal(
  { onCancel, ariaLabel, children }: {
    readonly onCancel: () => void;
    readonly ariaLabel: string;
    readonly children: ReactNode;
  }
) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    dialog.showModal();
    const onCancelEvent = (event: Event): void => {
      event.preventDefault();
      onCancelRef.current();
    };
    dialog.addEventListener("cancel", onCancelEvent);
    return () => {
      dialog.removeEventListener("cancel", onCancelEvent);
      if (dialog.open) dialog.close();
    };
  }, []);

  return (
    <dialog ref={dialogRef} className="modal" aria-label={ariaLabel}>
      {children}
    </dialog>
  );
}
