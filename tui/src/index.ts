/**
 * The one door `cli/` opens into `tui/`. `cli/src/main.ts` parses arguments,
 * discovers the project, opens the Vault, and creates the backend (the
 * embedded worker or an HTTP attach); everything after that — building the
 * app source and running the render-once or interactive loop — is `startTui`.
 */
export {
  startTui,
  type StartTuiOptions,
  type StartTuiRenderOnce,
  type TuiBackend
} from "./launch.js";
export { RecoveryWarningFeed } from "./recovery-warning-feed.js";

/**
 * The background update check, for `1667 web` as well as the TUI. It lives
 * under `tui/` but imports nothing from the renderer, and its contract is
 * surface-agnostic: it hands a caller one notice message and a stop hook,
 * and the caller decides how to show it. `cli/src/web-update-notice.ts`
 * publishes that message through `/api/status`; `./launch.js` gives it to
 * the interactive TUI. Both reach the registry the same way, under the same
 * cache key, so neither run is distinguishable from the other and the two
 * share one 24-hour cache.
 */
export {
  createBackgroundUpdateStarter,
  type BackgroundUpdateStarter
} from "./update-runtime.js";
