import { useAppContext } from "./context.js";
import { useStore } from "./store.js";
import { registerPreload } from "./preload.js";
import { lazyView } from "../ui/LazyView.js";

// Each dialog's code loads when its state first asks for it.
const NoteDialog = lazyView(async () => (await import("../notes/NoteDialog.js")).NoteDialog, { floating: true });
registerPreload("notes", () => NoteDialog.preload());
const FactCheckDialog = lazyView(async () => (await import("../factcheck/FactCheckDialog.js")).FactCheckDialog, { floating: true });
const ImportReportDialog = lazyView(async () => (await import("../imports/ImportReportDialog.js")).ImportReportDialog, { floating: true });

/** The dialogs of the notes, the Fact check and the imports. */
export function LazyDialogs() {
  const { store, actions } = useAppContext();
  const noteOpen = useStore(store, (state) => state.notes.open !== null);
  const factCheckOpen = useStore(store, (state) => state.factCheck.confirm !== null);
  const importReport = useStore(store, (state) => state.imports.report !== null);
  return (
    <>
      {noteOpen && <NoteDialog onDismiss={actions.notes.close} />}
      {factCheckOpen && <FactCheckDialog onDismiss={actions.factCheck.cancel} />}
      {importReport && <ImportReportDialog onDismiss={actions.imports.closeReport} />}
    </>
  );
}
