import { useEffect } from "react";
import { pushKeyLayer } from "../app/keymap.js";
import { useAppContext } from "../app/context.js";
import { useStore } from "../app/store.js";
import { KeysDialog } from "./KeysDialog.js";
import { LogDialog } from "./LogDialog.js";
import { SearchDialog } from "../search/SearchDialog.js";
import { PaletteDialog } from "./PaletteDialog.js";
import "./features.js";

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

  if (overlay === "palette") return <PaletteDialog onClose={actions.overlay.close} openLibrary={openLibrary} />;
  if (overlay === "keys") return <KeysDialog onClose={actions.overlay.close} />;
  if (overlay === "log") return <LogDialog onClose={actions.overlay.close} />;
  if (overlay === "search") return <SearchDialog onClose={actions.overlay.close} />;
  return null;
}
