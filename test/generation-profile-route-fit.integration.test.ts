import assert from "node:assert/strict";
import test from "node:test";
import { effectiveGenerationSettings } from "../server/settings-v2-conversion.js";
import { exportGenerationProfile, importProfileExport } from "../server/import-profile-export.js";
import { validateSamplingRoute } from "../server/settings-v2-sampling-validation.js";
import {
  generationEffortAvailabilityForTarget,
  generationEffortChoicesForTarget
} from "../shared/generation-effort-capabilities.js";
import { fitProfileToRoute } from "../shared/generation-profile-transfer.js";
import { openAiDocument } from "./generation-profile-transfer-fixtures.js";

test("Profile transfer resolves prompt caching by exact route and policy", () => {
  const official = {
    ...openAiDocument(),
    connections: {
      "builtin:dry-run": {
        ...openAiDocument().connections["builtin:dry-run"]!,
        preset: "openai" as const,
        baseUrl: "https://api.openai.com/v1"
      }
    },
    models: {
      "builtin:dry-run": {
        ...openAiDocument().models["builtin:dry-run"]!,
        remoteId: "gpt-5.6",
        capabilities: {
          ...openAiDocument().models["builtin:dry-run"]!.capabilities,
          promptCaching: "unknown" as const
        }
      }
    }
  };
  const automatic = fitProfileToRoute(official, "default", {
    name: "Exact OpenAI",
    cachePolicy: "auto"
  });
  assert.equal(automatic.document.profiles.default?.cachePolicy, "auto");
  assert.equal(automatic.importedCount, 1);
  assert.equal(automatic.candidateCount, 1);

  const long = fitProfileToRoute(official, "default", {
    name: "Unsupported long cache",
    cachePolicy: "long"
  });
  assert.equal(long.document.profiles.default?.cachePolicy, "off");
  assert.equal(long.importedCount, 0);
  assert.equal(long.candidateCount, 1);
  assert.match(long.fidelity.join("; "), /cache policy not imported; No long cache\./u);
});

test("Profile transfer rejects Anthropic effort off through the exact route", () => {
  const anthropic = {
    ...openAiDocument(),
    connections: {
      "builtin:dry-run": {
        ...openAiDocument().connections["builtin:dry-run"]!,
        protocol: "anthropic-messages" as const,
        preset: "anthropic" as const,
        baseUrl: "https://api.anthropic.com"
      }
    },
    models: {
      "builtin:dry-run": {
        ...openAiDocument().models["builtin:dry-run"]!,
        capabilities: {
          ...openAiDocument().models["builtin:dry-run"]!.capabilities,
          reasoningEffort: "supported" as const
        }
      }
    },
    profiles: {
      default: { ...openAiDocument().profiles.default!, effort: "medium" as const }
    }
  };
  const fitted = fitProfileToRoute(anthropic, "default", {
    name: "No off",
    effort: "off"
  });
  assert.equal(fitted.document.profiles.default?.effort, "medium");
  assert.equal(fitted.importedCount, 0);
  assert.equal(fitted.candidateCount, 1);
  assert.match(
    fitted.fidelity.join("; "),
    /reasoning effort not imported; Anthropic does not support generation effort set to off/u
  );
  const target = { protocol: "anthropic-messages" as const, reasoningEffort: "supported" as const };
  assert.deepEqual(generationEffortChoicesForTarget(target), ["default", "low", "medium", "high"]);
  assert.deepEqual(generationEffortAvailabilityForTarget(target, "off"), {
    kind: "unavailable",
    code: "anthropic-off",
    reason: "Anthropic does not support generation effort set to off"
  });
  assert.throws(
    () => effectiveGenerationSettings({
      ...anthropic,
      profiles: {
        ...anthropic.profiles,
        default: { ...anthropic.profiles.default!, effort: "off" }
      }
    }),
    /Anthropic does not support generation effort set to off\./u
  );
});


test("Profile transfer omits Mirostat when the selected route cannot use it", () => {
  const officialOpenAi = {
    ...openAiDocument(),
    connections: {
      "builtin:dry-run": {
        ...openAiDocument().connections["builtin:dry-run"]!,
        preset: "openai" as const,
        baseUrl: "https://api.openai.com/v1"
      }
    },
    models: {
      "builtin:dry-run": {
        ...openAiDocument().models["builtin:dry-run"]!,
        remoteId: "gpt-4.1"
      }
    }
  };
  const anthropic = {
    ...openAiDocument(),
    connections: {
      "builtin:dry-run": {
        ...openAiDocument().connections["builtin:dry-run"]!,
        protocol: "anthropic-messages" as const,
        preset: "anthropic" as const,
        baseUrl: "https://api.anthropic.com"
      }
    }
  };
  for (const target of [officialOpenAi, anthropic]) {
    const fitted = fitProfileToRoute(target, "default", {
      name: "Unsupported Mirostat",
      sampling: { mirostat: 2, mirostatTau: 5, mirostatEta: 0.2 }
    });
    const profile = fitted.document.profiles.default!;
    assert.equal(profile.sampling, undefined);
    assert.equal(fitted.importedCount, 0);
    assert.equal(fitted.candidateCount, 3);
    assert.match(fitted.fidelity.join("; "), /mirostat not imported/u);
    validateSamplingRoute(
      "default",
      profile,
      fitted.document.models[profile.modelId]!,
      fitted.document.connections[fitted.document.models[profile.modelId]!.connectionId]!
    );
    assert.doesNotThrow(() => effectiveGenerationSettings(fitted.document));
  }
});


test("Profile transfer caps maximum output with the runtime model limit policy", () => {
  const candidate = { name: "Bounded", maxOutputTokens: 2_048 };
  const override = {
    ...openAiDocument(),
    connections: {
      "builtin:dry-run": {
        ...openAiDocument().connections["builtin:dry-run"]!,
        preset: "openai" as const,
        baseUrl: "https://api.openai.com/v1"
      }
    },
    models: {
      "builtin:dry-run": {
        ...openAiDocument().models["builtin:dry-run"]!,
        remoteId: "gpt-4.1",
        discovered: { maxOutputTokens: 1_024 },
        overrides: { maxOutputTokens: 512 }
      }
    }
  };
  const overrideFit = fitProfileToRoute(override, "default", candidate);
  assert.equal(overrideFit.document.profiles.default?.maxOutputTokens, 512);
  assert.equal(effectiveGenerationSettings(overrideFit.document).maxTokens, 512);
  assert.deepEqual(overrideFit.fidelity, ["maximum output clamped to 512"]);

  const discovered = {
    ...override,
    models: {
      "builtin:dry-run": {
        ...override.models["builtin:dry-run"]!,
        overrides: {}
      }
    }
  };
  const discoveredFit = fitProfileToRoute(discovered, "default", candidate);
  assert.equal(discoveredFit.document.profiles.default?.maxOutputTokens, 1_024);
  assert.equal(effectiveGenerationSettings(discoveredFit.document).maxTokens, 1_024);
  assert.deepEqual(discoveredFit.fidelity, ["maximum output clamped to 1024"]);

  const unknown = {
    ...discovered,
    models: {
      "builtin:dry-run": {
        ...discovered.models["builtin:dry-run"]!,
        discovered: {}
      }
    }
  };
  const unknownFit = fitProfileToRoute(unknown, "default", candidate);
  assert.equal(unknownFit.document.profiles.default?.maxOutputTokens, 2_048);
  assert.equal(effectiveGenerationSettings(unknownFit.document).maxTokens, 2_048);
  assert.deepEqual(unknownFit.fidelity, []);

  const runtimeMetadata = { runtime: { maxOutputTokens: 640 }, builtin: { maxOutputTokens: 320 } };
  const runtimeFit = fitProfileToRoute(unknown, "default", candidate, {
    modelMetadata: runtimeMetadata
  });
  assert.equal(runtimeFit.document.profiles.default?.maxOutputTokens, 640);
  assert.equal(effectiveGenerationSettings(runtimeFit.document, "default", runtimeMetadata).maxTokens, 640);
  assert.deepEqual(runtimeFit.fidelity, ["maximum output clamped to 640"]);

  const builtinMetadata = { builtin: { maxOutputTokens: 320 } };
  const builtinFit = fitProfileToRoute(unknown, "default", candidate, {
    modelMetadata: builtinMetadata
  });
  assert.equal(builtinFit.document.profiles.default?.maxOutputTokens, 320);
  assert.equal(effectiveGenerationSettings(builtinFit.document, "default", builtinMetadata).maxTokens, 320);
  assert.deepEqual(builtinFit.fidelity, ["maximum output clamped to 320"]);
});

