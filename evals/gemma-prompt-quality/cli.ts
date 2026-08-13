import { readFile } from "node:fs/promises";
import { parseJsonRejectingDuplicateKeys } from "../../server/strict-json.js";
import {
  createBlindPackArtifacts,
  parseBlindScores,
  readBlindMapping,
  readBlindPack,
  scoreReplay,
  writeBlindMapping,
  writeBlindPack,
  writeEvidence
} from "./scoring.js";
import { readReplayProfileManifest } from "./profile.js";
import { readGemmaRuntimeConfiguration } from "./runtime.js";
import { runReplay, writeReplay, type ReplayResult } from "./runner.js";
import { parseGemmaCompatibilityEvidence } from "./evidence-schema.js";
import { parseReplayResult } from "./replay-schema.js";

/**
 * Replay commands:
 *
 *   replay --endpoint URL --runtime-config RUNTIME.json --profile PROFILE.json --output replay.json
 *   blind --replay replay.json --output blind.json --mapping mapping.json
 *   score --replay replay.json --blind blind.json --mapping mapping.json
 *     --scores scores.json --output evidence.json
 *
 * The replay and blind files can contain endpoint data and prose. Keep them at
 * a user-selected local path. The score command writes only compact evidence.
 */

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "replay") {
    const endpoint = required(args, "--endpoint");
    const model = optional(args, "--model");
    const runtimePath = required(args, "--runtime-config");
    const profilePath = required(args, "--profile");
    const outputPath = required(args, "--output");
    const runtime = await readGemmaRuntimeConfiguration(runtimePath);
    const profile = await readReplayProfileManifest(profilePath, runtime);
    await writeReplay(outputPath, await runReplay({ endpointBaseUrl: endpoint, model, runtime, profile }));
    return;
  }
  if (command === "blind") {
    const replayPath = required(args, "--replay");
    const outputPath = required(args, "--output");
    const mappingPath = required(args, "--mapping");
    const artifacts = createBlindPackArtifacts(await readReplay(replayPath));
    await writeBlindPack(outputPath, artifacts.pack);
    await writeBlindMapping(mappingPath, artifacts.mapping);
    return;
  }
  if (command === "score") {
    const replayPath = required(args, "--replay");
    const blindPath = required(args, "--blind");
    const mappingPath = required(args, "--mapping");
    const scoresPath = required(args, "--scores");
    const outputPath = required(args, "--output");
    const evidence = scoreReplay(
      await readReplay(replayPath),
      parseBlindScores(parseJsonRejectingDuplicateKeys(
        await readFile(scoresPath, "utf8"),
        "Gemma blind scores"
      )),
      {
        pack: await readBlindPack(blindPath),
        mapping: await readBlindMapping(mappingPath)
      }
    );
    parseGemmaCompatibilityEvidence(evidence);
    await writeEvidence(outputPath, evidence);
    return;
  }
  throw new Error("Usage: replay, blind, or score");
}

async function readReplay(pathname: string): Promise<ReplayResult> {
  return parseReplayResult(parseJsonRejectingDuplicateKeys(
    await readFile(pathname, "utf8"),
    "Gemma replay"
  ));
}

function required(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index < 0 ? undefined : args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} is required`);
  return value;
}

function optional(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} must have a value`);
  return value;
}

export function isGemmaReplayCliEntry(pathname: string | undefined): boolean {
  if (pathname === undefined) return false;
  const normalized = pathname.replaceAll("\\", "/");
  return normalized === "evals/gemma-prompt-quality/cli.ts"
    || normalized.endsWith("/evals/gemma-prompt-quality/cli.ts");
}

if (isGemmaReplayCliEntry(process.argv[1])) {
  main().catch((error: unknown) => {
    process.stderr.write(`gemma prompt replay: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
