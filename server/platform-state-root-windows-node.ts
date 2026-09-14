import { loadNodeFfi } from "./node-ffi.js";
import type {
  WindowsPrivateStateRootAdapter
} from "./platform-state-root.js";
import {
  createWindowsPrivateStateRootAdapter
} from "./platform-state-root-windows-bun.js";

export function createNodeWindowsPrivateStateRootAdapter(): WindowsPrivateStateRootAdapter {
  return createWindowsPrivateStateRootAdapter(async () => loadNodeFfi());
}
