import assert from "node:assert/strict";
import test from "node:test";
import { attachProviderRuntime } from "../server/provider-runtime.js";
import { streamCompletion, type ReasoningStreamDelta } from "../server/providers.js";
import type { PromptPlan } from "../shared/prompt-plan.js";
import { EMPTY_SAMPLING_V2 } from "../shared/settings-v2-types.js";
import type { GenerationSettings } from "../shared/types.js";

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
