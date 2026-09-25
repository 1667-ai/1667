import { useAppContext } from "../app/context.js";
import { useStore } from "../app/store.js";
import { DeleteDialog } from "./DeleteDialog.js";
import { RenameDialog } from "./RenameDialog.js";

/**
 * Mounted once by `App.tsx`'s `Shell`, not nested inside `Sidebar` (review
 * fix B5): `state.library.dialog` is feature-local to the Library, but
 * whether a dialog is showing has nothing to do with whether the Sidebar
 * itself is currently the persistent column or a mounted drawer.
 */
export function LibraryDialogs() {
  const { store, actions } = useAppContext();
  const dialog = useStore(store, (state) => state.library.dialog);

  if (dialog.kind === "rename") {
    return (
      <RenameDialog
        title={dialog.title}
        onCancel={actions.library.cancelDialog}
        onSave={(title) => void actions.library.confirmRename(title)}
      />
    );
  }
  if (dialog.kind === "delete") {
    return (
      <DeleteDialog
        title={dialog.title}
        onCancel={actions.library.cancelDialog}
        onDelete={() => void actions.library.confirmDelete()}
      />
    );
  }
  return null;
}
