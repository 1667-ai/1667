import assert from "node:assert/strict";
import test from "node:test";
import { attachProviderRuntime } from "../server/provider-runtime.js";
import { streamCompletion, type ReasoningStreamDelta } from "../server/providers.js";
import type { PromptPlan } from "../shared/prompt-plan.js";
import { EMPTY_SAMPLING_V2 } from "../shared/settings-v2-types.js";
import type { GenerationSettings } from "../shared/types.js";
import { validateSettingsDocumentV2 } from "../server/settings-v2-validation.js";
import { INITIAL_SETTINGS_DOCUMENT_V2_TEXT } from "../server/settings-v2-initial-vectors.js";
import {
  applyBasicSettingsDraft,
  basicSettingsFromDocument
} from "../shared/settings-basic-draft.js";
import { withSupportedReasoningDisplays } from "../shared/reasoning-display-capabilities.js";

const PROMPT: PromptPlan = {
  operation: "continue",
  turns: [{
    role: "user",
    blocks: [{
      stability: "volatile",
      kind: "request",
      text: "Continue.",
      boundaryAfter: "none"
    }]
  }]
};

/** One KoboldCpp stream event. The endpoint sends one token per event, which
 *  is why a tag routinely arrives divided across several of them. */
function koboldToken(token: string): string {
  return `data: ${JSON.stringify({ token })}\n\n`;
}

function koboldFinish(): string {
  return `data: ${JSON.stringify({ token: "", finish_reason: "stop" })}\n\n`;
}

function textSettings(splitThinkTags: boolean): GenerationSettings {
  return attachProviderRuntime({
    provider: "text-completion",
    baseUrl: "https://kobold.example",
    model: "qwen",
    apiKeyEnv: null,
    temperature: 0,
    maxTokens: 128,
    systemPrompt: "Test.",
    contextWindow: null
  }, {
    preset: "koboldcpp",
    protocol: "text-completions",
    textPromptFormat: "raw",
    ...(splitThinkTags ? { splitThinkTags: true } : {}),
    auth: { type: "none" },
    headers: [],
    timeouts: {
      responseHeaderMs: 1_000,
      firstTokenMs: 1_000,
      idleMs: 1_000,
      totalMs: 5_000
    },
    allowInsecureHttp: false,
    effort: "default",
    tokenProbabilities: null,
    capabilities: {
      temperature: "supported",
      assistantPrefill: "unknown",
      reasoningEffort: "unknown",
      promptCaching: "unknown"
    },
    sampling: EMPTY_SAMPLING_V2
  });
}

function serveTokens(tokens: readonly string[]): () => void {
  const originalFetch = globalThis.fetch;
  const body = [...tokens.map(koboldToken), koboldFinish()].join("");
  globalThis.fetch = (async () => new Response(body, {
    headers: { "content-type": "text/event-stream" }
  })) as typeof fetch;
  return () => { globalThis.fetch = originalFetch; };
}

async function run(
  settings: GenerationSettings,
  tokens: readonly string[]
): Promise<{ prose: string; thought: string }> {
  const restore = serveTokens(tokens);
  try {
    const deltas: ReasoningStreamDelta[] = [];
    let prose = "";
    for await (const chunk of streamCompletion(settings, PROMPT, new AbortController().signal, {
      onReasoning: (delta) => { deltas.push(delta); }
    })) {
      prose += chunk;
    }
    return { prose, thought: deltas.map((delta) => delta.text).join("") };
  } finally {
    restore();
  }
}

// A thinking model on a text route emits its thought inline. These drive the
// real KoboldCpp event shape, one token per event, so the tag arrives divided
// exactly the way the endpoint divides it.
test("a text route keeps a think block out of the prose when the connection splits it", async () => {
  const { prose, thought } = await run(textSettings(true), [
    "<think>", "Three ", "ways ", "down.", "</think>", "She ", "chose ", "the rope."
  ]);

  assert.equal(prose, "She chose the rope.");
  assert.equal(thought, "Three ways down.");
});

test("a tag divided across tokens is still recognised, and never reaches the prose", async () => {
  const { prose, thought } = await run(textSettings(true), [
    "<th", "ink", ">", "Weighing.", "</", "think", ">", "The lantern guttered."
  ]);

  assert.equal(prose, "The lantern guttered.");
  assert.equal(thought, "Weighing.");
});

test("text that only looks like the start of a tag is released as prose", async () => {
  const { prose, thought } = await run(textSettings(true), [
    "She wrote <thin", "gs to do> on the slate."
  ]);

  assert.equal(prose, "She wrote <things to do> on the slate.");
  assert.equal(thought, "");
});

test("an unclosed think block keeps its text as the thought, not as prose", async () => {
  const { prose, thought } = await run(textSettings(true), [
    "<think>", "The generation stopped here"
  ]);

  assert.equal(prose, "");
  assert.equal(thought, "The generation stopped here");
});

test("a connection without the split passes every token through untouched", async () => {
  const { prose, thought } = await run(textSettings(false), [
    "<think>", "Three ways down.", "</think>", "She chose the rope."
  ]);

  assert.equal(prose, "<think>Three ways down.</think>She chose the rope.");
  assert.equal(thought, "");
});

// The two channels leave through separate redactors, so a credential divided
// between them survives both. `reasoningSafeToStore` is the commit-time gate
// for exactly that, and it only works if this route reports what it resolved.
test("a text route publishes its resolved secrets for the commit-time thought check", async () => {
  process.env.AI_1667_TEST_THINK_SECRET = "text-route-secret";
  try {
    const settings = attachProviderRuntime({
      provider: "text-completion",
      baseUrl: "https://kobold.example",
      model: "qwen",
      apiKeyEnv: null,
      temperature: 0,
      maxTokens: 128,
      systemPrompt: "Test.",
      contextWindow: null
    }, {
      preset: "koboldcpp",
      protocol: "text-completions",
      textPromptFormat: "raw",
      splitThinkTags: true,
      auth: { type: "bearer-env", env: "AI_1667_TEST_THINK_SECRET" },
      headers: [],
      timeouts: {
        responseHeaderMs: 1_000,
        firstTokenMs: 1_000,
        idleMs: 1_000,
        totalMs: 5_000
      },
      allowInsecureHttp: false,
      effort: "default",
      tokenProbabilities: null,
      capabilities: {
        temperature: "supported",
        assistantPrefill: "unknown",
        reasoningEffort: "unknown",
        promptCaching: "unknown"
      },
      sampling: EMPTY_SAMPLING_V2
    });
    const providerSecrets: { secrets: readonly string[] } = { secrets: [] };
    const restore = serveTokens(["<think>", "a thought", "</think>", "prose"]);
    try {
      for await (const _chunk of streamCompletion(
        settings,
        PROMPT,
        new AbortController().signal,
        { providerSecrets }
      )) {
        // Drain.
      }
    } finally {
      restore();
    }

    assert.deepEqual(providerSecrets.secrets, ["text-route-secret"]);
  } finally {
    delete process.env.AI_1667_TEST_THINK_SECRET;
  }
});

function textCompletionDocument(
  options: { readonly split: boolean; readonly reasoning?: "open" }
): unknown {
  const base = JSON.parse(INITIAL_SETTINGS_DOCUMENT_V2_TEXT) as {
    connections: Record<string, Record<string, unknown>>;
    models: Record<string, Record<string, unknown>>;
    profiles: Record<string, Record<string, unknown>>;
    [key: string]: unknown;
  };
  const connection = base.connections["builtin:dry-run"]!;
  const model = base.models["builtin:dry-run"]!;
  const profile = base.profiles.default!;
  return {
    ...base,
    connections: {
      kobold: {
        ...connection,
        name: "Kobold",
        preset: "koboldcpp",
        protocol: "text-completions",
        baseUrl: "https://kobold.example",
        ...(options.split ? { splitThinkTags: true } : {})
      }
    },
    models: {
      qwen: {
        ...model,
        connectionId: "kobold",
        name: "qwen",
        remoteId: "qwen",
        capabilities: {
          ...(model.capabilities as Record<string, unknown>),
          reasoningContent: "unsupported"
        }
      }
    },
    profiles: {
      default: {
        ...profile,
        modelId: "qwen",
        ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning })
      }
    }
  };
}

// The settings row offers `open` once the split is on, so the document that
// choice writes has to survive a save. Keying the gate off the model alone
// refused a value the writer had just been given.
test("a split connection accepts an explicit reasoning display the model alone would refuse", () => {
  const accepted = validateSettingsDocumentV2(
    textCompletionDocument({ split: true, reasoning: "open" })
  );
  assert.equal(accepted.profiles.default!.reasoning, "open");

  assert.throws(
    () => validateSettingsDocumentV2(textCompletionDocument({ split: false, reasoning: "open" })),
    /sets reasoning on a model that returns none/
  );
});

test("changing a split text connection to a chat provider drops the flag", () => {
  const document = validateSettingsDocumentV2(textCompletionDocument({ split: true }));
  assert.equal(document.connections.kobold!.splitThinkTags, true);

  const moved = applyBasicSettingsDraft(document, {
    ...basicSettingsFromDocument(document),
    provider: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5.2",
    apiKeyEnv: null
  });

  for (const connection of Object.values(moved.connections)) {
    assert.equal("splitThinkTags" in connection, false);
  }
  // The flag is what `parseConnections` refuses off a text protocol, so the
  // moved document has to survive its own validator.
  validateSettingsDocumentV2(moved);
});

// Enable, choose a display the split unlocked, disable. The row is a toggle,
// so this is two keypresses apart and entirely ordinary.
test("turning the split off clears a reasoning display it had unlocked", () => {
  const document = validateSettingsDocumentV2(
    textCompletionDocument({ split: true, reasoning: "open" })
  );
  assert.equal(document.profiles.default!.reasoning, "open");

  const off = withSupportedReasoningDisplays({
    ...document,
    connections: {
      kobold: (({ splitThinkTags: _off, ...rest }) => rest)(document.connections.kobold!)
    }
  });

  assert.equal("reasoning" in off.profiles.default!, false);
  // The whole point: the document the writer is left holding still saves.
  validateSettingsDocumentV2(off);
});

test("a protocol change carrying an unlocked display still saves", () => {
  const document = validateSettingsDocumentV2(
    textCompletionDocument({ split: true, reasoning: "open" })
  );

  const moved = applyBasicSettingsDraft(document, {
    ...basicSettingsFromDocument(document),
    provider: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5.2",
    apiKeyEnv: null
  });

  // The display survives here on purpose. The move rebuilds the model with no
  // stated reasoning capability, which reads as `unknown`, and a chat route
  // may well return reasoning. What must not survive is a document the save
  // refuses, which is the only property worth pinning either way.
  validateSettingsDocumentV2(moved);
});
