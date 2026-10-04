/** The key actions the overlays handle: `:`, `?`, `!`, and Esc to close one.
 * `app/keymap.ts` opens them; keys help lists only handled actions. Search
 * (`/`) lists its own in `search/search-keys.ts`. */
export const OVERLAY_KEY_ACTIONS: readonly string[] = ["open-commands", "open-keys", "open-log", "cancel"];
