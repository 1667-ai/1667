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
