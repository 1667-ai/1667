import { Icon, ICONS } from "./icons.js";

/** The ☰ button that opens the Library drawer. CSS shows it only below the
 * drawer breakpoint (`styles/sidebar.css`). The story header puts it in its
 * own row, left of the title; other screens put it in `.main-toolbar`. */
export function SidebarToggle({ onOpen }: { readonly onOpen: () => void }) {
  return (
    <button type="button" className="icon-btn sidebar-toggle" title="Stories" aria-label="Stories" onClick={onOpen}>
      <Icon path={ICONS.menu} />
    </button>
  );
}
