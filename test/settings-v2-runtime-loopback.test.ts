import assert from "node:assert/strict";
import test from "node:test";
import { providerRequestTransportAvailable } from "../server/settings-v2-runtime.js";
import { attachProviderRuntime } from "../server/provider-runtime.js";
import { ownedLoopbackHttpSupported } from "../server/provider-fetch.js";
import { validateSettingsDocumentV2 } from "../server/settings-v2-validation.js";
import { INITIAL_SETTINGS_DOCUMENT_V2 } from "../server/settings-v2-default.js";
import { applyBasicSettingsDraft, basicSettingsFromDocument } from "../shared/settings-basic-draft.js";
import type { GenerationSettings } from "../shared/types.js";

/** A model server on this machine must not be harder to reach than the same
 * server on the network. Every layer between the draft and the transport has
 * to agree about that, or the provider is offered and then refused. */
test("the insecure-HTTP opt-in reaches loopback through every layer", () => {
  const draft: GenerationSettings = {
    ...basicSettingsFromDocument(INITIAL_SETTINGS_DOCUMENT_V2),
    provider: "openai-compatible",
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "loaded-model",
    allowInsecureHttp: true
  };

  // 1. The draft keeps the flag instead of stripping it back out.
  const document = applyBasicSettingsDraft(INITIAL_SETTINGS_DOCUMENT_V2, draft);
  assert.equal(basicSettingsFromDocument(document).allowInsecureHttp, true);

  // 2. The document validates rather than being refused at save.
  assert.doesNotThrow(() => validateSettingsDocumentV2(document));

  // 3. Runtime admission lets the request through on a target with no proof.
  const settings = attachProviderRuntime({ ...draft }, runtime(true), true);
  assert.equal(providerRequestTransportAvailable(settings), true);

  // Without the opt-in it still depends on the proof, exactly as before.
  const bare = attachProviderRuntime({ ...draft, allowInsecureHttp: false }, runtime(false), true);
  assert.equal(providerRequestTransportAvailable(bare), ownedLoopbackHttpSupported());
});

function runtime(allowInsecureHttp: boolean) {
  return {
    preset: "custom" as const,
    auth: { type: "none" as const },
    headers: [],
    timeouts: { responseHeaderMs: 1_000, firstTokenMs: 1_000, idleMs: 1_000, totalMs: 5_000 },
    allowInsecureHttp,
    effort: "default" as const,
    capabilities: {
      temperature: "supported" as const,
      assistantPrefill: "unknown" as const,
      reasoningEffort: "unknown" as const,
      promptCaching: "unknown" as const
    }
  };
}
