import path from "node:path";
import { webBridgeProtocols } from "../../client/web-bridge-transport.js";
import { WEB_BRIDGE_PATH } from "../../shared/web-bridge-protocol.js";
import { READY_LINE } from "../test/web-e2e-fixture.js";
import { runStandalone } from "./standalone-smoke-process.js";

/**
 * `1667 web` under `--compile` (#409): guards the `__AI_1667_WEB_ASSETS__`
 * define (a compiled executable has no `web/` directory to build assets
 * from at runtime, unlike a source run) and the `ws` builtin `host/web-bridge-server.ts`
 * imports (compiling never installs `node_modules`, so this is the only
 * place that import is proven to resolve inside a compiled executable).
 */
export async function smokeStandaloneWeb(
  executable: string,
  directory: string,
  environment: Record<string, string>
): Promise<void> {
  const dataDir = path.join(directory, "web-smoke-data");
  const child = Bun.spawn(
    [executable, "web", "--data", dataDir, "--port", "0", "--no-open"],
    { cwd: directory, env: environment, stdout: "pipe", stderr: "pipe" }
  );
  try {
    const readyUrl = await readWebReadyUrl(child.stdout);
    const parsed = new URL(readyUrl);
    const token = new URLSearchParams(parsed.hash.replace(/^#/, "")).get("token");
    if (token === null) {
      throw new Error(`Standalone web smoke printed a URL with no token: ${readyUrl}`);
    }

    const appJs = await fetch(`${parsed.origin}/app.js`);
    if (appJs.status !== 200) {
      throw new Error(`Standalone web smoke could not fetch /app.js (${appJs.status})`);
    }
    const appJsBody = await appJs.text();
    if (!appJsBody.includes(WEB_BRIDGE_PATH)) {
      throw new Error("Standalone web smoke's /app.js does not reference the bridge");
    }

    const socket = new WebSocket(`ws://${parsed.host}${WEB_BRIDGE_PATH}`, {
      protocols: webBridgeProtocols(token),
      headers: { origin: parsed.origin }
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Standalone web smoke bridge did not send a hello")),
        10_000
      );
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as { type?: string };
        if (message.type === "hello") {
          clearTimeout(timeout);
          resolve();
        }
      });
      socket.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("Standalone web smoke bridge socket errored"));
      });
    });
    socket.close();
  } finally {
    child.kill("SIGINT");
    const exitCode = await child.exited;
    if (exitCode !== 0) {
      throw new Error(
        `Standalone web smoke did not stop cleanly (${exitCode}): `
          + await new Response(child.stderr).text()
      );
    }
  }
}

async function readWebReadyUrl(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const timeout = setTimeout(() => {
    void reader.cancel("web smoke startup timeout");
  }, 30_000);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const match = READY_LINE.exec(buffered);
      if (match !== null) return match[2]!;
    }
    throw new Error(`Standalone web smoke exited before readiness: ${buffered}`);
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
}
