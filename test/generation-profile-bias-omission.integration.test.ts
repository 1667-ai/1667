import assert from "node:assert/strict";
import test from "node:test";
import {
  combineSamplingBiasSources,
  resolveSamplingLogitBias
} from "../server/sampling-phrase-bias.js";
import { validateSamplingRoute } from "../server/settings-v2-sampling-validation.js";
import { fitProfileToRoute } from "../shared/generation-profile-transfer.js";
import { EMPTY_SAMPLING_V2 } from "../shared/settings-v2-types.js";
import { samplingBiasPresetRules } from "../shared/sampling-capabilities.js";
import { openAiDocument } from "./generation-profile-transfer-fixtures.js";

test("Profile transfer keeps text bias that fits after one rejected entry is removed", () => {
  const phraseBias = Array.from(
    { length: 30 },
    (_, index) => ({ phrase: `phrase-${index}`, weight: index + 1 })
  );
  const bannedStrings = [
    "rejected ban",
    ...Array.from({ length: 24 }, (_, index) => `ban-${index}`)
  ];
  const sampling = { ...EMPTY_SAMPLING_V2, phraseBias, bannedStrings };
  const tokenize = (text: string) => {
    const value = text.trim().toLowerCase();
    if (value === "rejected ban") return { kind: "unencodable" as const };
    const phrase = /^phrase-(\d+)$/u.exec(value);
    if (phrase !== null) return { kind: "single-token" as const, tokenId: Number(phrase[1]) + 1 };
    const banned = /^ban-(\d+)$/u.exec(value);
    if (banned !== null) return { kind: "single-token" as const, tokenId: Number(banned[1]) + 31 };
    throw new Error(`unexpected text bias value: ${text}`);
  };
  const rules = samplingBiasPresetRules("llama-cpp");
  const resolution = resolveSamplingLogitBias(
    combineSamplingBiasSources(sampling),
    tokenize,
    rules
  );
  const fitted = fitProfileToRoute(openAiDocument(), "default", {
    name: "Retained text bias",
    sampling: { phraseBias, bannedStrings }
  }, { samplingBiasResolution: resolution });
  const profile = fitted.document.profiles.default!;

  assert.deepEqual(profile.sampling?.phraseBias, phraseBias);
  assert.deepEqual(profile.sampling?.bannedStrings, bannedStrings.slice(1));
  assert.equal(fitted.importedCount, 2);
  assert.equal(fitted.candidateCount, 2);
  assert.match(
    fitted.fidelity.join("; "),
    /banned string not imported; "rejected ban" has no exact token/u
  );
  assert.doesNotMatch(fitted.fidelity.join("; "), /exceeding the 200-entry limit/u);

  const fittedResolution = resolveSamplingLogitBias(
    combineSamplingBiasSources(profile.sampling!),
    tokenize,
    rules
  );
  if (fittedResolution.kind !== "resolved") throw new Error("fitted text bias did not resolve");
  assert.equal(fittedResolution.resolvedEntryCount, 54);
  validateSamplingRoute(
    "default",
    profile,
    fitted.document.models[profile.modelId]!,
    fitted.document.connections[fitted.document.models[profile.modelId]!.connectionId]!,
    fittedResolution
  );
});
