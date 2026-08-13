import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { canonicalJson } from "../../server/canonical-json.js";
import { parseJsonRejectingDuplicateKeys } from "../../server/strict-json.js";

/** Immutable local runtime identity for one Gemma replay. */
export interface GemmaRuntimeConfiguration {
  readonly schemaVersion: 1;
  readonly runtime: "llama.cpp";
  readonly model: {
    readonly id: "gemma-4-31b";
    readonly identity: "Gemma 4 31B";
    readonly artifact: {
      readonly fileName: string;
      readonly sha256: string;
      readonly quantization: string;
    };
  };
  readonly llamaCpp: {
    readonly build: string;
    readonly chatTemplate: string;
    readonly contextWindow: number;
  };
}

export interface GemmaRuntimeRecord {
  readonly configuration: GemmaRuntimeConfiguration;
  readonly fingerprint: string;
}

/** Read the checked runtime manifest. It intentionally has no endpoint or credentials. */
export async function readGemmaRuntimeConfiguration(pathname: string): Promise<GemmaRuntimeRecord> {
  return parseGemmaRuntimeConfiguration(parseJsonRejectingDuplicateKeys(
    await readFile(pathname, "utf8"),
    "Gemma runtime configuration"
  ));
}

export function parseGemmaRuntimeConfiguration(value: unknown): GemmaRuntimeRecord {
  const root = record(value, "Gemma runtime configuration");
  keys(root, ["schemaVersion", "runtime", "model", "llamaCpp"], "Gemma runtime configuration");
  exact(root.schemaVersion, 1, "Gemma runtime configuration.schemaVersion");
  exact(root.runtime, "llama.cpp", "Gemma runtime configuration.runtime");
  const model = record(root.model, "Gemma runtime configuration.model");
  keys(model, ["id", "identity", "artifact"], "Gemma runtime configuration.model");
  exact(model.id, "gemma-4-31b", "Gemma runtime configuration.model.id");
  exact(model.identity, "Gemma 4 31B", "Gemma runtime configuration.model.identity");
  const artifact = record(model.artifact, "Gemma runtime configuration.model.artifact");
  keys(artifact, ["fileName", "sha256", "quantization"], "Gemma runtime configuration.model.artifact");
  const fileName = safeText(artifact.fileName, "Gemma runtime configuration.model.artifact.fileName");
  const artifactSha256 = fingerprint(artifact.sha256, "Gemma runtime configuration.model.artifact.sha256");
  const quantization = safeText(artifact.quantization, "Gemma runtime configuration.model.artifact.quantization");
  const llamaCpp = record(root.llamaCpp, "Gemma runtime configuration.llamaCpp");
  keys(llamaCpp, ["build", "chatTemplate", "contextWindow"], "Gemma runtime configuration.llamaCpp");
  const build = safeText(llamaCpp.build, "Gemma runtime configuration.llamaCpp.build");
  const chatTemplate = safeText(llamaCpp.chatTemplate, "Gemma runtime configuration.llamaCpp.chatTemplate");
  const contextWindow = llamaCpp.contextWindow;
  if (typeof contextWindow !== "number" || !Number.isSafeInteger(contextWindow) || contextWindow < 1) {
    throw new Error("Gemma runtime configuration.llamaCpp.contextWindow must be a positive integer");
  }
  const configuration: GemmaRuntimeConfiguration = {
    schemaVersion: 1,
    runtime: "llama.cpp",
    model: {
      id: "gemma-4-31b",
      identity: "Gemma 4 31B",
      artifact: { fileName, sha256: artifactSha256, quantization }
    },
    llamaCpp: { build, chatTemplate, contextWindow }
  };
  return {
    configuration,
    fingerprint: `sha256:${createHash("sha256").update(canonicalJson(configuration), "utf8").digest("hex")}`
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const received = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (received.length !== sorted.length || received.some((key, index) => key !== sorted[index])) {
    throw new Error(`${label} has unsupported or missing fields`);
  }
}

function exact(value: unknown, expected: unknown, label: string): void {
  if (value !== expected) throw new Error(`${label} is invalid`);
}

function fingerprint(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} must be a SHA-256 fingerprint`);
  }
  return value;
}

function safeText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || value.length > 240
    || /[\u0000-\u001F\u007F]/u.test(value)
    || /(?:https?:\/\/|www\.|\b(?:api[-_ ]?key|authorization|password|secret|token)\s*[:=])/iu.test(value)) {
    throw new Error(`${label} must be a short, trimmed identifier without a URL or credential-like value`);
  }
  return value;
}
