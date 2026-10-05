import { useEffect } from "react";
import { pushKeyLayer } from "../app/keymap.js";
import { useAppContext } from "../app/context.js";
import { useStore } from "../app/store.js";
import { lazyView } from "../ui/LazyView.js";

// Each dialog loads when it is first opened. The palette brings every
// feature's commands with it (`./features.js`).
const PaletteDialog = lazyView(async () => (await Promise.all([import("./features.js"), import("./PaletteDialog.js")]))[1].PaletteDialog, { floating: true });
const KeysDialog = lazyView(async () => (await Promise.all([import("./features.js"), import("./KeysDialog.js")]))[1].KeysDialog, { floating: true });
const LogDialog = lazyView(async () => (await import("./LogDialog.js")).LogDialog, { floating: true });
const SearchDialog = lazyView(async () => (await import("../search/SearchDialog.js")).SearchDialog, { floating: true });

/**
 * The palette, keys help, notice log and search: dialogs over the page, not routes,
 * so Back and Forward never see them. While one is open it sits on the key
 * stack and claims Esc, so Esc closes it and never stops a running generation.
 */
export function Overlays({ openLibrary }: { readonly openLibrary: () => void }) {
  const { store, actions } = useAppContext();
  const overlay = useStore(store, (state) => state.overlay);

  useEffect(() => {
    if (overlay === null) return;
    return pushKeyLayer({ resolve: () => null, handle: () => false, claimsEscape: true });
  }, [overlay]);

  if (overlay === "palette") return <PaletteDialog onClose={actions.overlay.close} onDismiss={actions.overlay.close} openLibrary={openLibrary} />;
  if (overlay === "keys") return <KeysDialog onClose={actions.overlay.close} onDismiss={actions.overlay.close} />;
  if (overlay === "log") return <LogDialog onClose={actions.overlay.close} onDismiss={actions.overlay.close} />;
  if (overlay === "search") return <SearchDialog onClose={actions.overlay.close} onDismiss={actions.overlay.close} />;
  return null;
}
