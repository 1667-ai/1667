import {
  createBunWindowsPrivateStateRootAdapter
} from "./platform-state-root-windows-bun.js";

const [operation, root, trustedBase] = process.argv.slice(2);
const adapter = createBunWindowsPrivateStateRootAdapter();

try {
  if (operation === "local-app-data") {
    process.stdout.write(await adapter.localAppDataDirectory());
  } else if (operation === "prepare" && root !== undefined) {
    process.stdout.write(
      await adapter.preparePrivateStateRoot(root, trustedBase)
    );
  } else {
    throw new Error("Windows private state helper received invalid arguments");
  }
} catch (error) {
  process.stderr.write(
    error instanceof Error ? error.message : String(error)
  );
  process.exitCode = 1;
}
