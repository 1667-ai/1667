/** Thin re-export: the reference key table itself moved to
 *  `shared/reference-bindings.ts` (max reuse with the web UI's keymap — see
 *  `web/src/app/keymap-dom.ts`). Every existing TUI import of this module
 *  keeps working unchanged.
 *
 *  The two `extends` checks below are compile-time-only drift guards: if the
 *  shared table's derived `ReferenceMode`/`ReferenceAction` ever grew a value
 *  outside the TUI's own `AppMode`/`KeyAction` unions, these fail to compile
 *  instead of the mismatch surfacing later as a silent no-op binding. */
export * from "../../shared/reference-bindings.js";

import type { ReferenceAction, ReferenceMode } from "../../shared/reference-bindings.js";
import type { AppMode, KeyAction } from "./keys.js";

type AssertActionSubset = ReferenceAction extends KeyAction
  ? true
  : ["ReferenceAction has a value KeyAction does not", ReferenceAction];
type AssertModeSubset = ReferenceMode extends AppMode
  ? true
  : ["ReferenceMode has a value AppMode does not", ReferenceMode];

// Referenced (not just declared) so an unused-locals lint cannot hide either
// check quietly failing to compile.
const _actionSubsetCheck: AssertActionSubset = true;
const _modeSubsetCheck: AssertModeSubset = true;
void _actionSubsetCheck;
void _modeSubsetCheck;
