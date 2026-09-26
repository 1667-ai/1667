/** Thin re-export: the node-fs reading-position store moved to
 *  `host/reading-position-store.ts` (#409 step 4) so `1667 web` can serve the
 *  same durable positions the TUI reads/writes here. Every existing TUI
 *  import of this module keeps working unchanged — same file format, path
 *  scheme, debounce, atomic writes, and cap. */
export * from "../../host/reading-position-store.js";
