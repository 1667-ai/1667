import { useAppContext } from "./context.js";
import { useStore } from "./store.js";
import { NoteDialog } from "../notes/NoteDialog.js";
import { lazyView } from "../ui/LazyView.js";

// The note dialog holds typed text, so it is part of the first load. The Fact
// check and import dialogs load when their state first asks for them.
const FactCheckDialog = lazyView(() => import("../factcheck/FactCheckDialog.js"), "FactCheckDialog", { floating: true, asked: true });
const ImportReportDialog = lazyView(() => import("../imports/ImportReportDialog.js"), "ImportReportDialog", { floating: true, asked: true });

/** The dialogs of the notes, the Fact check and the imports. */
export function LazyDialogs() {
  const { store, actions } = useAppContext();
  const noteOpen = useStore(store, (state) => state.notes.open !== null);
  const factCheckOpen = useStore(store, (state) => state.factCheck.confirm !== null);
  const importReport = useStore(store, (state) => state.imports.report !== null);
  return (
    <>
      {noteOpen && <NoteDialog />}
      {factCheckOpen && <FactCheckDialog onDismiss={actions.factCheck.cancel} />}
      {importReport && <ImportReportDialog onDismiss={actions.imports.closeReport} />}
    </>
  );
}
