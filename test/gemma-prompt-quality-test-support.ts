import { type IncomingMessage, type Server } from "node:http";
import { type Server as SecureServer } from "node:https";
import type { AddressInfo } from "node:net";
import { EMPTY_SAMPLING_V2 } from "../shared/settings-v2-types.js";
import { parseReplayProfileManifest } from "../evals/gemma-prompt-quality/profile.js";
import { parseGemmaRuntimeConfiguration } from "../evals/gemma-prompt-quality/runtime.js";

export const TEST_RUNTIME = parseGemmaRuntimeConfiguration({
  schemaVersion: 1,
  runtime: "koboldcpp",
  model: {
    id: "koboldcpp/gemma-4-31B-it-uncensored-heretic-Q8_0",
    identity: "Gemma 4 31B test runtime",
    artifact: {
      fileName: "gemma-4-31B-it-uncensored-heretic-Q8_0.gguf",
      sha256: `sha256:${"a".repeat(64)}`,
      quantization: "Q8_0"
    }
  },
  koboldCpp: {
    version: "1.117.1",
    chatTemplateSha256: "sha256:0a52be69cda5ab8aeb627d6ff51a7b34c7d06afabb6b0f00cf8ee63df16a6315",
    contextWindow: 32768
  }
});

export function testProfile() {
  return parseReplayProfileManifest({
    schemaVersion: 1,
    runtimeArtifactSha256: TEST_RUNTIME.configuration.model.artifact.sha256,
    profile: {
      name: "Gemma test profile",
      generation: {
        temperature: 0.7,
        maxOutputTokens: 400,
        effort: "default",
        cachePolicy: "off",
        tokenProbabilities: null
      },
      sampling: {
        ...EMPTY_SAMPLING_V2,
        topP: 0.92,
        topK: 40,
        minP: 0.05,
        repeatPenalty: 1.08
      },
      timeouts: { responseHeaderMs: 600_000, firstTokenMs: 120_000, idleMs: 120_000, totalMs: 1_800_000 }
    }
  }, TEST_RUNTIME);
}

export function requestText(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

export function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

export function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}

export function listenSecure(server: SecureServer): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(`https://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

export function closeSecure(server: SecureServer): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}
