import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPackagedBuildIdentity } from "../../shared/build-identity.js";

interface BunBuildOutput {
  text(): Promise<string>;
}

interface BunBuildResult {
  success: boolean;
  logs: readonly unknown[];
  outputs: readonly BunBuildOutput[];
}

test("embedded Bun worker starts without a Koffi package", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-embedded-worker-build-"));
  const outputFile = path.join(root, "worker.js");
  const bootstrapFile = path.join(root, "bootstrap.ts");
  const machineState = path.join(root, "machine-state");
  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../.."
  );
  try {
    const [tiktokenWasmBase64, photonWasmBase64] = await Promise.all([
      readFile(
        path.join(repositoryRoot, "node_modules/tiktoken/tiktoken_bg.wasm"),
        "base64"
      ),
      readFile(
        path.join(
          repositoryRoot,
          "node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm"
        ),
        "base64"
      )
    ]);
    const identity = createPackagedBuildIdentity({
      productVersion: "0.10.9",
      sourceCommit: "a".repeat(40),
      sourceDirty: false,
      buildTimestamp: "2026-01-01T00:00:00.000Z",
      artifactTarget: "windows-x64"
    });
    const bun = (globalThis as unknown as {
      Bun: {
        build(options: Record<string, unknown>): Promise<BunBuildResult>;
      };
    }).Bun;
    const build = await bun.build({
      entrypoints: [path.join(repositoryRoot, "server", "worker.ts")],
      target: "bun",
      define: {
        __AI_1667_BUILD_IDENTITY__: JSON.stringify(identity),
        __AI_1667_TIKTOKEN_WASM_BASE64__: JSON.stringify(tiktokenWasmBase64),
        __AI_1667_PHOTON_WASM_BASE64__: JSON.stringify(photonWasmBase64)
      },
      external: ["koffi"],
      minify: true
    });
    if (!build.success || build.outputs.length !== 1) {
      throw new Error(build.logs.join("\n"));
    }
    const source = await build.outputs[0]!.text();
    expect(/\bfrom\s*["']koffi["']/u.test(source)).toBe(false);
    await writeFile(outputFile, source);
    await writeFile(bootstrapFile, bootstrapSource());

    const child = spawnSync(
      process.execPath,
      ["--no-install", bootstrapFile],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          AI_1667_STATE: machineState,
          BUN_CONFIG_NO_AUTO_INSTALL: "1",
          BUN_INSTALL: path.join(root, "bun-install")
        }
      }
    );
    expect(child.status).toBe(0);
    expect(child.signal).toBe(null);
    expect(child.stdout).toBe("started\nstopped\n");
    expect(child.stderr).not.toContain("koffi");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function bootstrapSource(): string {
  return `
import { readFile } from "node:fs/promises";
const source = await readFile(new URL("./worker.js", import.meta.url), "utf8");
const worker = new Worker(
  URL.createObjectURL(new Blob([source], { type: "text/javascript" })),
  { type: "module" }
);
worker.onmessage = (event) => {
  const message = event.data;
  if (message?.type === "starting") {
    process.stdout.write("started\\n");
    worker.postMessage({ type: "shutdown" });
  }
  if (message?.type === "stopped") {
    process.stdout.write("stopped\\n");
    worker.terminate();
    process.exit(0);
  }
};
worker.onerror = (event) => {
  process.stderr.write(String(event.message ?? event));
  process.exit(1);
};
`;
}
