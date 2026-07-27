import type {
  WindowsPrivateStateRootAdapter
} from "./platform-state-root.js";

/** Select the source or packaged implementation without loading Bun FFI in Node. */
export async function createWindowsPrivateStateRootAdapter(): Promise<
  WindowsPrivateStateRootAdapter
> {
  if (process.platform !== "win32") {
    throw new Error("Windows private state preparation requires Windows");
  }
  return process.versions.bun === undefined
    ? await nodeAdapter()
    : await bunAdapter();
}

async function nodeAdapter(): Promise<WindowsPrivateStateRootAdapter> {
  const { createNodeWindowsPrivateStateRootAdapter } = await import(
    "./platform-state-root-windows-node.js"
  );
  return createNodeWindowsPrivateStateRootAdapter();
}

async function bunAdapter(): Promise<WindowsPrivateStateRootAdapter> {
  const { createBunWindowsPrivateStateRootAdapter } = await import(
    "./platform-state-root-windows-bun.js"
  );
  return createBunWindowsPrivateStateRootAdapter();
}
