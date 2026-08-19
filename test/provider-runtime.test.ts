import assert from "node:assert/strict";
import test from "node:test";
import { ProviderError } from "../server/errors.js";
import {
  attachProviderRuntime,
  providerRuntimeFor,
  providerRuntimeFromV2,
  redactProviderBody,
  redactProviderSecrets,
  resolveProviderHeaders,
  type ProviderRuntime
} from "../server/provider-runtime.js";
import {
  BoundedProviderSseParser,
  providerSseEvents
} from "../server/provider-sse.js";
import {
  streamCompletion,
  type StreamOutcome
} from "../server/providers.js";
import type { PromptPlan } from "../shared/prompt-plan.js";
import { EMPTY_SAMPLING_V2 } from "../shared/settings-v2-types.js";
import type { GenerationSettings } from "../shared/types.js";
import { supportsAssistantPrefill } from "../shared/continuation-plan.js";
import { providerRequestTransportAvailable } from "../server/settings-v2-runtime.js";

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

test("v2 authentication and custom-header references resolve only at dispatch", () => {
  process.env.AI_1667_TEST_NAMED_AUTH = "named-secret";
  process.env.AI_1667_TEST_CUSTOM_HEADER = "custom-secret";
  try {
    const settings = attached({
      auth: {
        type: "header-env",
        name: "x-provider-key",
        env: "AI_1667_TEST_NAMED_AUTH"
      },
      headers: [{
        name: "x-tenant-token",
        value: { type: "env", env: "AI_1667_TEST_CUSTOM_HEADER" }
      }]
    });
    const resolved = resolveProviderHeaders(settings, { "content-type": "application/json" });
    assert.deepEqual(resolved.headers, {
      "content-type": "application/json",
      "x-provider-key": "named-secret",
      "x-tenant-token": "custom-secret"
    });
    assert.deepEqual(resolved.secrets, ["named-secret", "custom-secret"]);
    assert.equal(
      redactProviderSecrets("named-secret/custom-secret/named-secret", resolved.secrets),
      "[REDACTED]/[REDACTED]/[REDACTED]"
    );
    assert.equal(
      redactProviderSecrets("abcdef", ["abc", "abcdef"]),
      "[REDACTED]"
    );
    assert.equal(
      redactProviderSecrets("xxxx", ["x", "E", "D", "R"]),
      "[REDACTED]"
    );
    assert.equal(
      redactProviderSecrets("abcd", ["abc", "bcd"]),
      "[REDACTED]"
    );
    assert.equal(
      redactProviderSecrets("abcdefgh", ["bc", "abcdefgh"]),
      "[REDACTED]"
    );
  } finally {
    delete process.env.AI_1667_TEST_NAMED_AUTH;
    delete process.env.AI_1667_TEST_CUSTOM_HEADER;
  }
});

test("stored bearer and named-header credentials resolve and enter redaction", () => {
  const cases = [
    {
      auth: { type: "bearer-stored", secretId: "connection:openai" } as const,
      expected: { authorization: "Bearer stored-bearer-secret" },
      secret: "stored-bearer-secret"
    },
    {
      auth: {
        type: "header-stored",
        name: "x-api-key",
        secretId: "connection:anthropic:x-api-key"
      } as const,
      expected: { "x-api-key": "stored-header-secret" },
      secret: "stored-header-secret"
    }
  ];
  for (const { auth, expected, secret } of cases) {
    const runtime = providerRuntimeFromV2({
      name: "Stored fixture",
      preset: "custom",
      protocol: "openai-chat-completions",
      baseUrl: "https://models.example/v1",
      auth,
      headers: [],
      timeouts: {
        responseHeaderMs: 1_000,
        firstTokenMs: 1_000,
        idleMs: 1_000,
        totalMs: 5_000
      }
    }, "default", {
      temperature: "supported",
      assistantPrefill: "unknown",
      reasoningEffort: "unknown",
      promptCaching: "unknown"
    }, {
      environment: {},
      storedSecrets: new Map([[auth.secretId, secret]])
    });
    const resolved = resolveProviderHeaders(
      attachProviderRuntime(baseSettings(), runtime),
      {}
    );
    assert.deepEqual(resolved.headers, expected);
    assert.deepEqual(resolved.secrets, [secret]);
    assert.equal(
      redactProviderSecrets(`provider echoed ${secret}`, resolved.secrets),
      "provider echoed [REDACTED]"
    );
  }
});

test("stored credential lookup has a distinct non-secret diagnostic", () => {
  assert.throws(
    () => resolveProviderHeaders(attached({
      auth: { type: "bearer-stored", secretId: "connection:missing" }
    }), {}),
    (error) => error instanceof ProviderError
      && error.message.includes("Stored API key")
      && !error.message.includes("environment variable")
  );
});

test("transport policy admits opted-in keyless LAN hosts but never public HTTP or credentials", () => {
  assert.equal(providerRequestTransportAvailable(attached({
    auth: { type: "bearer-stored", secretId: "connection:https" }
  }, {
    baseUrl: "https://models.example/v1"
  })), true);
  assert.equal(providerRequestTransportAvailable(attached({
    auth: { type: "bearer-stored", secretId: "connection:http" },
    allowInsecureHttp: true
  }, {
    baseUrl: "http://192.168.1.50:8080/v1"
  })), false);

  for (const baseUrl of [
    "http://192.168.1.50:8080/v1",
    "http://gpu-box.local:11434/v1",
    "http://gpu-box:11434/v1"
  ]) {
    assert.equal(providerRequestTransportAvailable(attached({
      auth: { type: "none" },
      allowInsecureHttp: true
    }, { baseUrl })), true, baseUrl);
  }
  assert.equal(providerRequestTransportAvailable(attached({
    auth: { type: "none" },
    allowInsecureHttp: true
  }, {
    baseUrl: "http://models.example.com/v1"
  })), false);
});

test("resolved named authentication preserves the __proto__ header", () => {
  process.env.AI_1667_TEST_PROTO_AUTH = "prototype-secret";
  try {
    const resolved = resolveProviderHeaders(attached({
      auth: {
        type: "header-env",
        name: "__proto__",
        env: "AI_1667_TEST_PROTO_AUTH"
      }
    }), {});
    assert.equal(Object.hasOwn(resolved.headers, "__proto__"), true);
    assert.equal(resolved.headers["__proto__"], "prototype-secret");
    assert.deepEqual(resolved.secrets, ["prototype-secret"]);
  } finally {
    delete process.env.AI_1667_TEST_PROTO_AUTH;
  }
});

test("resolved headers reject case-insensitive adapter collisions", () => {
  process.env.AI_1667_TEST_COLLIDING_HEADER = "collision-secret";
  try {
    assert.throws(
      () => resolveProviderHeaders(attached({
        headers: [{
          name: "Content-Type",
          value: {
            type: "env",
            env: "AI_1667_TEST_COLLIDING_HEADER"
          }
        }]
      }), { "content-type": "application/json" }),
      /conflicts with adapter-owned or duplicate header/
    );
  } finally {
    delete process.env.AI_1667_TEST_COLLIDING_HEADER;
  }
});

test("provider JSON redaction covers credentials represented as primitives", () => {
  assert.equal(redactProviderBody("123456", ["123456"]), '"[REDACTED]"');
  assert.equal(redactProviderBody("true", ["true"]), '"[REDACTED]"');
  assert.equal(redactProviderBody("null", ["null"]), '"[REDACTED]"');
  assert.deepEqual(
    JSON.parse(redactProviderBody(
      '{"error":123456,"nested":[1234567,false,null]}',
      ["123456", "false", "null"]
    )),
    {
      error: "[REDACTED]",
      nested: ["[REDACTED]", "[REDACTED]", "[REDACTED]"]
    }
  );
});

test("v2 runtime uses its bounded credential snapshot, not later process environment", () => {
  const runtime = providerRuntimeFromV2({
    name: "Fixture",
    preset: "custom",
    protocol: "openai-chat-completions",
    baseUrl: "https://models.example/v1",
    auth: { type: "bearer-env", env: "AI_1667_SNAPSHOT_KEY" },
    headers: [],
    timeouts: {
      responseHeaderMs: 1_000,
      firstTokenMs: 1_000,
      idleMs: 1_000,
      totalMs: 5_000
    }
  }, "default", {
    temperature: "supported",
    assistantPrefill: "unknown",
    reasoningEffort: "unknown",
    promptCaching: "unknown"
  }, {
    environment: {
      AI_1667_SNAPSHOT_KEY: "snapshotted-secret"
    }
  });
  process.env.AI_1667_SNAPSHOT_KEY = "later-process-value";
  try {
    const resolved = resolveProviderHeaders(
      attachProviderRuntime(baseSettings(), runtime),
      {}
    );
    assert.equal(resolved.headers.authorization, "Bearer snapshotted-secret");
    assert.deepEqual(resolved.secrets, ["snapshotted-secret"]);
  } finally {
    delete process.env.AI_1667_SNAPSHOT_KEY;
  }
});

test("credentials with wire-normalized surrounding whitespace are rejected", () => {
  process.env.AI_1667_NONCANONICAL_KEY = "wire-secret ";
  try {
    assert.throws(
      () => resolveProviderHeaders(attached({
        auth: {
          type: "bearer-env",
          env: "AI_1667_NONCANONICAL_KEY"
        }
      }), {}),
      (error) => error instanceof ProviderError
        && error.message.includes("surrounding HTTP whitespace")
        && !error.message.includes("wire-secret")
    );
  } finally {
    delete process.env.AI_1667_NONCANONICAL_KEY;
  }
});

test("explicit assistant-prefill capability overrides endpoint heuristics", () => {
  assert.equal(supportsAssistantPrefill(attached({
    capabilities: {
      temperature: "supported",
      assistantPrefill: "unsupported",
      reasoningEffort: "unknown",
      promptCaching: "unknown"
    }
  })), false);
  assert.equal(supportsAssistantPrefill(attached({
    capabilities: {
      temperature: "supported",
      assistantPrefill: "supported",
      reasoningEffort: "unknown",
      promptCaching: "unknown"
    }
  })), true);
  assert.equal(supportsAssistantPrefill(attached({
    capabilities: {
      temperature: "supported",
      assistantPrefill: "unknown",
      reasoningEffort: "unknown",
      promptCaching: "unknown"
    }
  }, {
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    model: "claude-sonnet-4-6"
  })), false);
});

test("legacy IPv6 loopback URLs retain their local provider presets", () => {
  const cases = [
    [1234, "lm-studio"],
    [11434, "ollama"],
    [8080, "llama-cpp"],
    [5001, "koboldcpp"]
  ] as const;
  for (const [port, preset] of cases) {
    assert.equal(providerRuntimeFor({
      ...baseSettings(),
      baseUrl: `http://[::1]:${port}/v1`
    }).preset, preset);
  }
});

test("legacy preset inference does not treat 127-prefixed DNS as loopback", () => {
  assert.equal(providerRuntimeFor({
    ...baseSettings(),
    baseUrl: "https://127.example.com:11434/v1"
  }).preset, "custom");
});

test("provider errors redact every resolved secret", async (t) => {
  process.env.AI_1667_TEST_REDACT = "provider-secret";
  process.env.AI_1667_TEST_DISPATCH_HEADER = "header-secret";
  t.after(() => {
    delete process.env.AI_1667_TEST_REDACT;
    delete process.env.AI_1667_TEST_DISPATCH_HEADER;
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    assert.ok(input instanceof Request);
    assert.equal(input.headers.get("authorization"), "Bearer provider-secret");
    assert.equal(input.headers.get("x-tenant-secret"), "header-secret");
    return new Response("provider-secret/header-secret is invalid", { status: 401 });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  await assert.rejects(
    drain(streamCompletion(
      attached({
        auth: { type: "bearer-env", env: "AI_1667_TEST_REDACT" },
        headers: [{
          name: "x-tenant-secret",
          value: { type: "env", env: "AI_1667_TEST_DISPATCH_HEADER" }
        }]
      }),
      PROMPT,
      new AbortController().signal
    )),
    (error) => error instanceof ProviderError
      && error.body === "[REDACTED]/[REDACTED] is invalid"
      && !error.message.includes("provider-secret")
      && !error.message.includes("header-secret")
  );
});

test("provider error bodies redact JSON-escaped reflected credentials", async (t) => {
  const secret = 'quote-"slash\\end';
  process.env.AI_1667_TEST_ESCAPED_REDACT = secret;
  t.after(() => { delete process.env.AI_1667_TEST_ESCAPED_REDACT; });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({
    error: { message: `${secret} is invalid` }
  }, { status: 401 })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  await assert.rejects(
    drain(streamCompletion(
      attached({
        auth: {
          type: "bearer-env",
          env: "AI_1667_TEST_ESCAPED_REDACT"
        }
      }),
      PROMPT,
      new AbortController().signal
    )),
    (error) => {
      if (!(error instanceof ProviderError)) return false;
      const parsed = JSON.parse(error.body) as {
        error?: { message?: string };
      };
      return parsed.error?.message === "[REDACTED] is invalid"
        && !error.message.includes("quote-");
    }
  );
});

test("malformed provider diagnostics redact JSON-escaped credentials", async (t) => {
  const secret = 'malformed-"slash\\secret';
  const escaped = JSON.stringify(secret).slice(1, -1);
  process.env.AI_1667_TEST_MALFORMED_REDACT = secret;
  t.after(() => { delete process.env.AI_1667_TEST_MALFORMED_REDACT; });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    `{"error":{"message":"${escaped}"}} trailing`,
    { status: 401 }
  )) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  await assert.rejects(
    drain(streamCompletion(
      attached({
        auth: {
          type: "bearer-env",
          env: "AI_1667_TEST_MALFORMED_REDACT"
        }
      }),
      PROMPT,
      new AbortController().signal
    )),
    (error) => error instanceof ProviderError
      && error.body.includes("[REDACTED]")
      && !error.body.includes(secret)
      && !error.body.includes(escaped)
      && !error.message.includes(secret)
      && !error.message.includes(escaped)
  );
});

test("request-header validation never exposes a malformed resolved secret", async (t) => {
  const secret = "header-canary\r\ninjected";
  process.env.AI_1667_TEST_INVALID_HEADER = secret;
  t.after(() => { delete process.env.AI_1667_TEST_INVALID_HEADER; });

  await assert.rejects(
    drain(streamCompletion(
      attached({
        auth: {
          type: "bearer-env",
          env: "AI_1667_TEST_INVALID_HEADER"
        }
      }),
      PROMPT,
      new AbortController().signal
    )),
    (error) => error instanceof ProviderError
      && error.message.includes("[REDACTED]")
      && !error.message.includes("header-canary")
      && !error.message.includes("injected")
  );
});

test("successful provider streams redact reflected credentials from diagnostics", async (t) => {
  const secret = "stream-reflected-secret";
  process.env.AI_1667_TEST_STREAM_SECRET = secret;
  t.after(() => { delete process.env.AI_1667_TEST_STREAM_SECRET; });
  const originalFetch = globalThis.fetch;
  let event = `not-json-${secret}`;
  globalThis.fetch = (async () => new Response(
    `data: ${event}\n\n`,
    { headers: { "content-type": "text/event-stream" } }
  )) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const auth = {
    type: "bearer-env" as const,
    env: "AI_1667_TEST_STREAM_SECRET"
  };

  await assert.rejects(
    drain(streamCompletion(
      attached({ auth }),
      PROMPT,
      new AbortController().signal
    )),
    (error) => error instanceof ProviderError
      && error.message.includes("[REDACTED]")
      && !error.message.includes(secret)
  );

  event = JSON.stringify({
    type: "error",
    error: { message: `${secret} was rejected` }
  });
  await assert.rejects(
    drain(streamCompletion(
      attached({
        auth: {
          type: "header-env",
          name: "x-api-key",
          env: "AI_1667_TEST_STREAM_SECRET"
        }
      }, {
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com"
      }),
      PROMPT,
      new AbortController().signal
    )),
    (error) => error instanceof ProviderError
      && error.message.includes("[REDACTED]")
      && !error.message.includes(secret)
  );
});

test("successful provider output redacts credentials split across deltas", async (t) => {
  const secret = "cross-delta-provider-secret";
  process.env.AI_1667_TEST_OUTPUT_SECRET = secret;
  t.after(() => { delete process.env.AI_1667_TEST_OUTPUT_SECRET; });
  const originalFetch = globalThis.fetch;
  let body = [
    openAiDelta(`Before ${secret.slice(0, 11)}`),
    openAiDelta(`${secret.slice(11)} after.`),
    "data: [DONE]\n\n"
  ].join("");
  globalThis.fetch = (async () => new Response(body, {
    headers: { "content-type": "text/event-stream" }
  })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const auth = {
    type: "bearer-env" as const,
    env: "AI_1667_TEST_OUTPUT_SECRET"
  };

  assert.equal(
    await collect(streamCompletion(
      attached({ auth }),
      PROMPT,
      new AbortController().signal
    )),
    "Before [REDACTED] after."
  );

  body = [
    anthropicDelta(`Before ${secret.slice(0, 9)}`),
    anthropicDelta(`${secret.slice(9)} after.`),
    `data: ${JSON.stringify({ type: "message_stop" })}\n\n`
  ].join("");
  assert.equal(
    await collect(streamCompletion(
      attached({
        auth: {
          type: "header-env",
          name: "x-api-key",
          env: "AI_1667_TEST_OUTPUT_SECRET"
        }
      }, {
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com"
      }),
      PROMPT,
      new AbortController().signal
    )),
    "Before [REDACTED] after."
  );
});

test("SSE diagnostics redact complete credentials before truncation", async (t) => {
  const secret = `cross-boundary-secret-${"z".repeat(80)}`;
  const fragment = secret.slice(0, 16);
  process.env.AI_1667_TEST_LONG_STREAM_SECRET = secret;
  t.after(() => { delete process.env.AI_1667_TEST_LONG_STREAM_SECRET; });
  const originalFetch = globalThis.fetch;
  let event = `${"x".repeat(190)}${secret}`;
  globalThis.fetch = (async () => new Response(
    `data: ${event}\n\n`,
    { headers: { "content-type": "text/event-stream" } }
  )) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const auth = {
    type: "header-env" as const,
    name: "x-api-key",
    env: "AI_1667_TEST_LONG_STREAM_SECRET"
  };

  await assert.rejects(
    drain(streamCompletion(attached({ auth }), PROMPT, new AbortController().signal)),
    (error) => error instanceof ProviderError
      && error.message.includes("[REDACTED]")
      && !error.message.includes(fragment)
  );

  const prefix = '{"type":"error","leaked":"';
  event = `${prefix}${"x".repeat(290 - prefix.length)}${secret}"}`;
  assert.equal(event.indexOf(secret), 290);
  await assert.rejects(
    drain(streamCompletion(
      attached({ auth }, {
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com"
      }),
      PROMPT,
      new AbortController().signal
    )),
    (error) => error instanceof ProviderError
      && error.message.includes("[REDACTED]")
      && !error.message.includes(fragment)
  );
});

test("a stalled provider stream survives its first-token floor and fails at the total deadline", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    assert.ok(input instanceof Request);
    const signal = init?.signal ?? input.signal;
    return new Response(new ReadableStream({
      start(controller) {
        signal?.addEventListener("abort", () => controller.error(signal.reason), {
          once: true
        });
      }
    }), { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const startedAt = Date.now();
  await assert.rejects(
    drain(streamCompletion(
      attached({
        timeouts: {
          responseHeaderMs: 50,
          // Issue #127: the first-token phase deadline is
          // Math.max(firstTokenMs, totalMs) (server/provider-sse.ts), so this
          // tiny configured floor can never fire on its own — the
          // connection's total deadline below is what actually reports, and
          // the assertion after this rejection proves the stream ran well
          // past this floor first.
          firstTokenMs: 20,
          idleMs: 20,
          totalMs: 300
        }
      }),
      PROMPT,
      new AbortController().signal
    )),
    (error) => error instanceof ProviderError
      && error.timeout === "provider-total"
      && /total deadline/.test(error.message)
  );
  // A stream that aborted at the old first-token-derived deadline would have
  // failed within tens of milliseconds. Surviving well past that tiny floor
  // is the proof that the total deadline, not the phase timer, ended this.
  assert.ok(Date.now() - startedAt >= 250);
});

test("caller cancellation is preserved while waiting for response headers", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    assert.ok(input instanceof Request);
    if (input.signal.aborted) throw input.signal.reason;
    return await new Promise<Response>((_resolve, reject) => {
      input.signal.addEventListener("abort", () => reject(input.signal.reason), {
        once: true
      });
    });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const controller = new AbortController();
  const reason = new Error("caller stopped generation");
  const pending = drain(streamCompletion(attached(), PROMPT, controller.signal));
  controller.abort(reason);

  await assert.rejects(pending, (error) => error === reason);
});

test("configured response-header deadline keeps typed timeout provenance", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    assert.ok(input instanceof Request);
    if (input.signal.aborted) throw input.signal.reason;
    return await new Promise<Response>((_resolve, reject) => {
      input.signal.addEventListener("abort", () => reject(input.signal.reason), {
        once: true
      });
    });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  await assert.rejects(
    drain(streamCompletion(attached({
      timeouts: {
        responseHeaderMs: 20,
        firstTokenMs: 100,
        idleMs: 100,
        totalMs: 3_000
      }
    }), PROMPT, new AbortController().signal)),
    (error) => error instanceof ProviderError
      && error.timeout === "provider-response-header"
      && /response headers/.test(error.message)
  );
});

test("a stream that sends headers and then stays silent survives past the first-token floor to the total deadline", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    assert.ok(input instanceof Request);
    const signal = init?.signal ?? input.signal;
    // Headers arrive immediately; the body then never sends anything — a
    // server that flushed headers before hanging mid-prefill, the case
    // provider-sse.ts's first-token phase now has to tolerate.
    return new Response(new ReadableStream({
      start(controller) {
        signal?.addEventListener("abort", () => controller.error(signal.reason), {
          once: true
        });
      }
    }), { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const settings = attached({
    timeouts: {
      responseHeaderMs: 50,
      // A tiny floor on purpose: issue #127's fix means this value alone can
      // no longer end the generation, because the effective first-token
      // deadline is Math.max(firstTokenMs, totalMs).
      firstTokenMs: 10,
      idleMs: 10,
      totalMs: 300
    }
  });

  const startedAt = Date.now();
  await assert.rejects(
    drain(providerSseEvents(
      settings,
      "https://models.example/v1/chat/completions",
      { p: "x" },
      {},
      [],
      new AbortController().signal,
      (value) => value,
      undefined,
      undefined,
      (event) => event !== "[DONE]",
      (event) => event === "[DONE]"
    )),
    (error) => error instanceof ProviderError
      && error.timeout === "provider-total"
      && /total deadline/.test(error.message)
  );
  // Survived well past the 10 ms first-token and idle floors: the total
  // deadline, not a phase timer, is what ended this.
  assert.ok(Date.now() - startedAt >= 250);
});

test("a server that never sends response headers still fails at the configured header deadline, whatever the body size", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    assert.ok(input instanceof Request);
    if (input.signal.aborted) throw input.signal.reason;
    return await new Promise<Response>((_resolve, reject) => {
      input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true });
    });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const settings = attached({
    timeouts: {
      // Issue #127: this stays exactly the configured value. Before this
      // branch's fix, a body this large (20,000 bytes) would have derived a
      // far longer wait; now the header phase never looks at the body at
      // all.
      responseHeaderMs: 30,
      firstTokenMs: 100,
      idleMs: 100,
      totalMs: 3_000
    }
  });

  const startedAt = Date.now();
  await assert.rejects(
    drain(providerSseEvents(
      settings,
      "https://models.example/v1/chat/completions",
      { p: "x".repeat(20_000) },
      {},
      [],
      new AbortController().signal,
      (value) => value,
      undefined,
      undefined,
      (event) => event !== "[DONE]",
      (event) => event === "[DONE]"
    )),
    (error) => error instanceof ProviderError
      && error.timeout === "provider-response-header"
      && /response headers/.test(error.message)
  );
  assert.ok(Date.now() - startedAt < 300);
});

test("caller cancellation is preserved while reading an error body", async (t) => {
  const originalFetch = globalThis.fetch;
  let responseStarted!: () => void;
  const started = new Promise<void>((resolve) => { responseStarted = resolve; });
  globalThis.fetch = (async (input, init) => {
    assert.ok(input instanceof Request);
    const signal = init?.signal ?? input.signal;
    return new Response(new ReadableStream({
      start(controller) {
        signal?.addEventListener("abort", () => {
          controller.error(signal.reason);
        }, { once: true });
        responseStarted();
      }
    }), { status: 502 });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const controller = new AbortController();
  const reason = new Error("caller stopped error-body read");
  const pending = drain(streamCompletion(attached(), PROMPT, controller.signal));
  await started;
  controller.abort(reason);

  await assert.rejects(pending, (error) => error === reason);
});

test("caller cancellation stops before draining buffered provider events", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => new Response(new ReadableStream({
    start(stream) {
      stream.enqueue(new TextEncoder().encode([
        openAiDelta("first"),
        openAiDelta(" second")
      ].join("")));
      assert.ok(input instanceof Request);
      const signal = init?.signal ?? input.signal;
      signal?.addEventListener("abort", () => {
        stream.error(signal.reason);
      }, { once: true });
    }
  }), {
    headers: { "content-type": "text/event-stream" }
  })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const controller = new AbortController();
  const reason = new Error("stop buffered generation");
  const iterator = streamCompletion(attached(), PROMPT, controller.signal);

  assert.deepEqual(await iterator.next(), { done: false, value: "first" });
  controller.abort(reason);
  await assert.rejects(iterator.next(), (error) => error === reason);
});

test("credentialed cancellation flushes the safe redaction tail", async (t) => {
  const secret = "12345678901234567890";
  process.env.AI_1667_TEST_CANCEL_SECRET = secret;
  t.after(() => { delete process.env.AI_1667_TEST_CANCEL_SECRET; });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    assert.ok(input instanceof Request);
    const signal = init?.signal ?? input.signal;
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          openAiDelta("abcdefghijklmnopqrstuvwxyz")
        ));
        signal?.addEventListener("abort", () => {
          controller.error(signal.reason);
        }, { once: true });
      }
    }), { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const controller = new AbortController();
  const reason = new Error("stop credentialed generation");
  const iterator = streamCompletion(attached({
    auth: {
      type: "bearer-env",
      env: "AI_1667_TEST_CANCEL_SECRET"
    }
  }), PROMPT, controller.signal);

  assert.deepEqual(await iterator.next(), { done: false, value: "abcdefg" });
  controller.abort(reason);
  assert.deepEqual(await iterator.next(), {
    done: false,
    value: "hijklmnopqrstuvwxyz"
  });
  await assert.rejects(iterator.next(), (error) => error === reason);
});

test("a provider rejection stays a rejection when the total timer fires after its redaction tail", async (t) => {
  const secret = "12345678901234567890";
  process.env.AI_1667_TEST_REJECTION_SECRET = secret;
  t.after(() => { delete process.env.AI_1667_TEST_REJECTION_SECRET; });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode([
        anthropicDelta("abcdefghijklmnopqrstuvwxyz"),
        `data: ${JSON.stringify({
          type: "error",
          error: { message: "The provider rejected this stream." }
        })}\n\n`
      ].join("")));
    }
  }), {
    headers: { "content-type": "text/event-stream" }
  })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const iterator = streamCompletion(
    attached({
      auth: {
        type: "header-env",
        name: "x-api-key",
        env: "AI_1667_TEST_REJECTION_SECRET"
      },
      timeouts: {
        responseHeaderMs: 1_000,
        firstTokenMs: 1_000,
        idleMs: 1_000,
        totalMs: 30
      }
    }, {
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com"
    }),
    PROMPT,
    new AbortController().signal
  );

  assert.deepEqual(await iterator.next(), { done: false, value: "abcdefg" });
  assert.deepEqual(await iterator.next(), {
    done: false,
    value: "hijklmnopqrstuvwxyz"
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  await assert.rejects(iterator.next(), (error) => error instanceof ProviderError
    && error.timeout === undefined
    && /Anthropic stream error/.test(error.message));
});

test("a transport abort cannot replace a provider-classified stream failure", async (t) => {
  const transport = new AbortController();
  const caller = new AbortController();
  const providerFailure = new ProviderError("The provider rejected the stream.");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(new ReadableStream({
    start(controller) {
      setImmediate(() => {
        transport.abort(new Error("outer total deadline"));
        controller.error(providerFailure);
      });
    }
  }), {
    headers: { "content-type": "text/event-stream" }
  })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  await assert.rejects(
    drain(providerSseEvents(
      attached(),
      "https://models.example/v1/chat/completions",
      {},
      {},
      [],
      transport.signal,
      (value) => value,
      undefined,
      undefined,
      () => true,
      () => false,
      caller.signal
    )),
    (error) => error === providerFailure
  );
});

test("OpenAI parameter retries share one total deadline", async (t) => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  let firstResponseTimer: ReturnType<typeof setTimeout> | null = null;
  globalThis.fetch = (async (input) => {
    assert.ok(input instanceof Request);
    requests += 1;
    if (requests === 1) {
      return await new Promise<Response>((resolve) => {
        firstResponseTimer = setTimeout(() => resolve(Response.json({
          error: {
            code: "unsupported_parameter",
            param: "max_tokens"
          }
        }, { status: 400 })), 150);
      });
    }
    if (input.signal.aborted) throw input.signal.reason;
    return await new Promise<Response>((_resolve, reject) => {
      input.signal.addEventListener("abort", () => reject(input.signal.reason), {
        once: true
      });
    });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (firstResponseTimer !== null) clearTimeout(firstResponseTimer);
  });
  const startedAt = Date.now();

  await assert.rejects(
    drain(streamCompletion(attached({
      timeouts: {
        responseHeaderMs: 1_000,
        firstTokenMs: 1_000,
        idleMs: 1_000,
        totalMs: 200
      }
    }), PROMPT, new AbortController().signal)),
    /total deadline/
  );

  assert.equal(requests, 2);
  assert.ok(Date.now() - startedAt < 300);
});

test("non-success stream body deadlines preserve the known provider status", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    assert.ok(input instanceof Request);
    const signal = init?.signal ?? input.signal;
    return new Response(new ReadableStream({
      start(controller) {
        signal?.addEventListener("abort", () => controller.error(signal.reason), {
          once: true
        });
      }
    }), {
      status: 400,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  await assert.rejects(
    drain(streamCompletion(
      attached({
        timeouts: {
          responseHeaderMs: 20,
          firstTokenMs: 20,
          idleMs: 20,
          totalMs: 30
        }
      }),
      PROMPT,
      new AbortController().signal
    )),
    (error) => error instanceof ProviderError
      && error.status === 400
      && /total deadline/.test(error.message)
  );
});

test("usage-only SSE events do not satisfy first activity, so a stall still runs to the total deadline", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    assert.ok(input instanceof Request);
    const signal = init?.signal ?? input.signal;
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'data: {"usage":{"prompt_tokens":12},"choices":[]}\n\n'
        ));
        signal?.addEventListener("abort", () => controller.error(signal.reason), {
          once: true
        });
      }
    }), { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  // Issue #127's fix means the tiny firstTokenMs floor below can never fire
  // on its own (see "a stalled provider stream survives its first-token
  // floor..." above) — what this test actually proves is narrower: a
  // usage-only event (no delta content) does not count as first activity, so
  // the connection keeps running against that phase's deadline (now the
  // total) instead of settling into the idle deadline.
  await assert.rejects(
    drain(streamCompletion(
      attached({
        timeouts: {
          responseHeaderMs: 50,
          firstTokenMs: 20,
          idleMs: 50,
          totalMs: 300
        }
      }),
      PROMPT,
      new AbortController().signal
    )),
    (error) => error instanceof ProviderError
      && error.timeout === "provider-total"
      && /total deadline/.test(error.message)
  );
});

test("OpenAI-compatible reasoning activity prevents a first-activity timeout without entering story prose", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    assert.ok(input instanceof Request);
    const signal = init?.signal ?? input.signal;
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'data: {"choices":[{"delta":{"reasoning_content":"plan"}}]}\n\n'
        ));
        const timer = setTimeout(() => {
          controller.enqueue(new TextEncoder().encode(
            'data: {"choices":[{"delta":{"content":"prose"}}]}\n\ndata: [DONE]\n\n'
          ));
          controller.close();
        }, 30);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          controller.error(signal.reason);
        }, { once: true });
      }
    }), { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  let output = "";
  for await (const delta of streamCompletion(
    attached({
      timeouts: {
        responseHeaderMs: 50,
        firstTokenMs: 20,
        idleMs: 80,
        totalMs: 200
      }
    }),
    PROMPT,
    new AbortController().signal
  )) output += delta;

  assert.equal(output, "prose");
});

test("Anthropic thinking activity prevents a first-activity timeout without entering story prose", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    assert.ok(input instanceof Request);
    const signal = init?.signal ?? input.signal;
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"plan"}}\n\n'
        ));
        const timer = setTimeout(() => {
          controller.enqueue(new TextEncoder().encode([
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"prose"}}',
            'data: {"type":"message_stop"}',
            "",
            ""
          ].join("\n\n")));
          controller.close();
        }, 30);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          controller.error(signal.reason);
        }, { once: true });
      }
    }), { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  let output = "";
  for await (const delta of streamCompletion(
    attached({
      timeouts: {
        responseHeaderMs: 50,
        firstTokenMs: 20,
        idleMs: 80,
        totalMs: 200
      }
    }, {
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com"
    }),
    PROMPT,
    new AbortController().signal
  )) output += delta;

  assert.equal(output, "prose");
});

test("OpenAI-compatible reasoning deltas reach onReasoning, counted, and never the prose stream", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    assert.ok(input instanceof Request);
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode([
          'data: {"choices":[{"delta":{"reasoning_content":"weigh"}}]}',
          'data: {"choices":[{"delta":{"reasoning_content":" options"}}]}',
          'data: {"choices":[{"delta":{"content":"prose"}}]}',
          "data: [DONE]",
          "",
          ""
        ].join("\n\n")));
        controller.close();
      }
    }), { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const reasoning: Array<{ text: string; tokenCount: number }> = [];
  const output = await collect(streamCompletion(
    attached(),
    PROMPT,
    new AbortController().signal,
    { onReasoning: (delta) => { reasoning.push(delta); } }
  ));

  assert.equal(output, "prose");
  assert.deepEqual(reasoning, [
    { text: "weigh", tokenCount: 1 },
    { text: " options", tokenCount: 2 }
  ]);
});

test("Anthropic thinking deltas reach onReasoning, counted, and never the prose stream", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    assert.ok(input instanceof Request);
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode([
          'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"weigh"}}',
          'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":" options"}}',
          'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"prose"}}',
          'data: {"type":"message_stop"}',
          "",
          ""
        ].join("\n\n")));
        controller.close();
      }
    }), { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const reasoning: Array<{ text: string; tokenCount: number }> = [];
  const output = await collect(streamCompletion(
    attached({}, {
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com"
    }),
    PROMPT,
    new AbortController().signal,
    { onReasoning: (delta) => { reasoning.push(delta); } }
  ));

  assert.equal(output, "prose");
  assert.deepEqual(reasoning, [
    { text: "weigh", tokenCount: 1 },
    { text: " options", tokenCount: 2 }
  ]);
});

test("dry-run fabricates short reasoning through onReasoning, separate from its prose", async () => {
  const reasoningChunks: string[] = [];
  const output = await collect(streamCompletion(
    attached({}, { provider: "dry-run" }),
    PROMPT,
    new AbortController().signal,
    { onReasoning: (delta) => { reasoningChunks.push(delta.text); } }
  ));

  const reasoningText = reasoningChunks.join("");
  assert.ok(reasoningText.length > 0);
  assert.ok(reasoningText.length < 200, "dry-run reasoning stays short");
  assert.ok(!output.includes(reasoningText.trim()));
  assert.ok(!reasoningText.includes(output.trim()));
});

test("streamCompletion without onReasoning drops reasoning deltas silently", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    assert.ok(input instanceof Request);
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode([
          'data: {"choices":[{"delta":{"reasoning_content":"weigh"}}]}',
          'data: {"choices":[{"delta":{"content":"prose"}}]}',
          "data: [DONE]",
          "",
          ""
        ].join("\n\n")));
        controller.close();
      }
    }), { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const output = await collect(streamCompletion(
    attached(),
    PROMPT,
    new AbortController().signal
  ));

  assert.equal(output, "prose");
});

test("configured idle deadline aborts after the first stream event", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    assert.ok(input instanceof Request);
    const signal = init?.signal ?? input.signal;
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'data: {"choices":[{"delta":{"content":"first"}}]}\n\n'
        ));
        signal?.addEventListener("abort", () => controller.error(signal.reason), {
          once: true
        });
      }
    }), { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  await assert.rejects(
    drain(streamCompletion(
      attached({
        timeouts: {
          responseHeaderMs: 50,
          firstTokenMs: 50,
          idleMs: 20,
          totalMs: 100
        }
      }),
      PROMPT,
      new AbortController().signal
    )),
    /stream was idle/
  );
});

test("provider idle time excludes slow downstream delta handling", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response([
    'data: {"choices":[{"delta":{"content":"first"}}]}',
    'data: {"choices":[{"delta":{"content":" second"}}]}',
    "data: [DONE]",
    "",
    ""
  ].join("\n\n"), {
    headers: { "content-type": "text/event-stream" }
  })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  let output = "";
  for await (const delta of streamCompletion(
    attached({
      timeouts: {
        responseHeaderMs: 50,
        firstTokenMs: 50,
        idleMs: 10,
        totalMs: 100
      }
    }),
    PROMPT,
    new AbortController().signal
  )) {
    output += delta;
    if (output === "first") {
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
    }
  }

  assert.equal(output, "first second");
});

test("OpenAI total time excludes draining an already-complete provider stream", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response([
    'data: {"choices":[{"delta":{"content":"first"}}]}',
    'data: {"choices":[{"delta":{"content":" second"}}]}',
    "data: [DONE]",
    "",
    ""
  ].join("\n\n"), {
    headers: { "content-type": "text/event-stream" }
  })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  let output = "";
  for await (const delta of streamCompletion(
    attached({
      timeouts: {
        responseHeaderMs: 50,
        firstTokenMs: 50,
        idleMs: 50,
        totalMs: 50
      }
    }),
    PROMPT,
    new AbortController().signal
  )) {
    output += delta;
    if (output === "first") {
      await new Promise<void>((resolve) => setTimeout(resolve, 75));
    }
  }

  assert.equal(output, "first second");
});

test("a queued terminal event wins over a later provider read failure", async (t) => {
  const originalFetch = globalThis.fetch;
  let failureTimer: ReturnType<typeof setTimeout> | null = null;
  globalThis.fetch = (async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode([
        'data: {"choices":[{"delta":{"content":"complete"}}]}',
        "data: [DONE]",
        "",
        ""
      ].join("\n\n")));
      failureTimer = setTimeout(() => {
        controller.error(new Error("late provider read failure"));
      }, 5);
    }
  }), {
    headers: { "content-type": "text/event-stream" }
  })) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (failureTimer !== null) clearTimeout(failureTimer);
  });

  let output = "";
  for await (const delta of streamCompletion(
    attached({
      timeouts: {
        responseHeaderMs: 100,
        firstTokenMs: 100,
        idleMs: 100,
        totalMs: 200
      }
    }),
    PROMPT,
    new AbortController().signal
  )) {
    output += delta;
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
  }

  assert.equal(output, "complete");
});

test("a queued terminal event wins over a later caller cancellation", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response([
    openAiDelta("complete"),
    "data: [DONE]\n\n"
  ].join(""), {
    headers: { "content-type": "text/event-stream" }
  })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const controller = new AbortController();
  const outcome: StreamOutcome = {
    finishReason: null,
    providerTerminal: false
  };
  const iterator = streamCompletion(
    attached(),
    PROMPT,
    controller.signal,
    { outcome }
  );

  assert.deepEqual(await iterator.next(), { done: false, value: "complete" });
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  controller.abort(new Error("late Stop"));

  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
  assert.equal(outcome.providerTerminal, true);
});

test("terminal evidence blocked on queue capacity wins over later caller cancellation", async (t) => {
  const originalFetch = globalThis.fetch;
  const firstEvent = JSON.stringify({
    choices: [{ delta: { content: "first" } }]
  });
  const emptyEvent = JSON.stringify({ choices: [{ delta: { content: "" } }] });
  const queuedEvent = JSON.stringify({
    choices: [{ delta: {
      content: "x".repeat(1_048_570 - emptyEvent.length)
    } }]
  });
  assert.equal(queuedEvent.length, 1_048_570);
  globalThis.fetch = (async () => new Response([
    `data: ${firstEvent}\n\n`,
    `data: ${queuedEvent}\n\n`,
    "data: [DONE]\n\n"
  ].join(""), {
    headers: { "content-type": "text/event-stream" }
  })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const controller = new AbortController();
  const iterator = providerSseEvents(
    attached(),
    "https://models.example/v1/chat/completions",
    {},
    {},
    [],
    controller.signal,
    (value) => value,
    undefined,
    undefined,
    (event) => event !== "[DONE]",
    (event) => event === "[DONE]"
  );

  assert.deepEqual(await iterator.next(), { done: false, value: firstEvent });
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  controller.abort(new Error("late Stop"));

  assert.deepEqual(await iterator.next(), {
    done: false,
    value: queuedEvent
  });
  assert.deepEqual(await iterator.next(), { done: false, value: "[DONE]" });
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
});

test("provider failures discard buffered nonterminal deltas", async (t) => {
  const originalFetch = globalThis.fetch;
  let failureTimer: ReturnType<typeof setTimeout> | null = null;
  globalThis.fetch = (async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode([
        openAiDelta("first"),
        openAiDelta(" second")
      ].join("")));
      failureTimer = setTimeout(() => {
        controller.error(new Error("provider failed after buffering"));
      }, 5);
    }
  }), {
    headers: { "content-type": "text/event-stream" }
  })) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (failureTimer !== null) clearTimeout(failureTimer);
  });
  const iterator = streamCompletion(
    attached(),
    PROMPT,
    new AbortController().signal
  );

  assert.deepEqual(await iterator.next(), { done: false, value: "first" });
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  await assert.rejects(
    iterator.next(),
    (error: unknown) => error instanceof ProviderError
      && /provider failed after buffering/.test(error.message)
  );
});

test("a queued provider failure wins over later caller cancellation", async (t) => {
  const originalFetch = globalThis.fetch;
  let failureTimer: ReturnType<typeof setTimeout> | null = null;
  globalThis.fetch = (async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode([
        openAiDelta("first"),
        openAiDelta(" second")
      ].join("")));
      failureTimer = setTimeout(() => {
        controller.error(new Error("provider failed before Stop"));
      }, 5);
    }
  }), {
    headers: { "content-type": "text/event-stream" }
  })) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (failureTimer !== null) clearTimeout(failureTimer);
  });
  const controller = new AbortController();
  const iterator = streamCompletion(
    attached(),
    PROMPT,
    controller.signal
  );

  assert.deepEqual(await iterator.next(), { done: false, value: "first" });
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  controller.abort(new Error("late Stop"));

  await assert.rejects(
    iterator.next(),
    (error: unknown) => error instanceof ProviderError
      && /provider failed before Stop/.test(error.message)
  );
});

test("provider EOF before a terminal event rejects partial output", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    openAiDelta("partial"),
    { headers: { "content-type": "text/event-stream" } }
  )) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  await assert.rejects(
    collect(streamCompletion(
      attached(),
      PROMPT,
      new AbortController().signal
    )),
    /ended before its terminal event/
  );
});

test("provider event buffering stops transport reads at its memory bound", async (t) => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  const event = `data: ${JSON.stringify({
    content: "x".repeat(300_000)
  })}\n\n`;
  let pulls = 0;
  let canceled = false;
  globalThis.fetch = (async () => new Response(new ReadableStream({
    pull(controller) {
      pulls += 1;
      if (pulls > 100) return void controller.close();
      controller.enqueue(encoder.encode(event));
    },
    cancel() {
      canceled = true;
    }
  }), {
    headers: { "content-type": "text/event-stream" }
  })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const iterator = providerSseEvents(
    attached(),
    "https://models.example/v1/chat/completions",
    {},
    {},
    [],
    new AbortController().signal,
    (value) => value
  );

  const first = await iterator.next();
  assert.equal(first.done, false);
  await new Promise<void>((resolve) => setTimeout(resolve, 25));

  assert.ok(pulls > 1);
  assert.ok(pulls < 12, `transport pulled ${pulls} chunks past queue credit`);

  await iterator.return(undefined);
  assert.equal(canceled, true);
});

test("SSE parsing accepts CR-only framing split across transport chunks", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(
        'data: {"choices":[{"delta":{"content":"cr"}}]}\r'
      ));
      controller.enqueue(encoder.encode("\rdata: [DONE]\r"));
      controller.enqueue(encoder.encode("\r"));
      controller.close();
    }
  }), {
    headers: { "content-type": "text/event-stream" }
  })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  let output = "";
  for await (const delta of streamCompletion(
    attached(),
    PROMPT,
    new AbortController().signal
  )) {
    output += delta;
  }
  assert.equal(output, "cr");
});

test("partial SSE parsing stays incremental under one-character drip", {
  timeout: 5_000
}, () => {
  const parser = new BoundedProviderSseParser();
  const startedAt = performance.now();
  parser.push(":");
  for (let index = 0; index < 200_000; index += 1) parser.push("x");
  assert.deepEqual(parser.push("\r\r"), []);
  assert.deepEqual(
    parser.push('data: {"choices":[]}\r\r'),
    ['{"choices":[]}']
  );
  assert.ok(performance.now() - startedAt < 2_000);
});

test("oversized SSE events fail with the stable provider limit diagnostic", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    `data: ${"x".repeat(1024 * 1024 + 1)}\n\n`,
    { headers: { "content-type": "text/event-stream" } }
  )) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  await assert.rejects(
    drain(streamCompletion(attached(), PROMPT, new AbortController().signal)),
    /provider_response_too_large/
  );
});

test("oversized ignored SSE comment frames fail at the event limit", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    `: ${"x".repeat(1024 * 1024 + 1)}\n\n`,
    { headers: { "content-type": "text/event-stream" } }
  )) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  await assert.rejects(
    drain(streamCompletion(attached(), PROMPT, new AbortController().signal)),
    /provider_response_too_large/
  );
});

test("complete SSE frames may share a transport chunk larger than the partial-frame limit", async (t) => {
  const originalFetch = globalThis.fetch;
  const chunk = new TextEncoder().encode(
    'data: {"choices":[]}\n\n'.repeat(120_000) + "data: [DONE]\n\n"
  );
  assert.ok(chunk.byteLength > 2 * 1024 * 1024);
  globalThis.fetch = (async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(chunk);
      controller.close();
    }
  }), {
    headers: { "content-type": "text/event-stream" }
  })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  await drain(streamCompletion(
    attached({
      timeouts: {
        responseHeaderMs: 5_000,
        firstTokenMs: 5_000,
        idleMs: 5_000,
        totalMs: 10_000
      }
    }),
    PROMPT,
    new AbortController().signal
  ));
});

function attached(
  overrides: Partial<ProviderRuntime> = {},
  settingsOverrides: Partial<GenerationSettings> = {}
): GenerationSettings {
  return attachProviderRuntime({ ...baseSettings(), ...settingsOverrides }, {
    preset: "custom",
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
    ...overrides,
    sampling: overrides.sampling ?? EMPTY_SAMPLING_V2
  }, true);
}

function baseSettings(): GenerationSettings {
  return {
    provider: "openai-compatible",
    baseUrl: "https://models.example/v1",
    model: "fixture",
    apiKeyEnv: null,
    temperature: 0,
    maxTokens: 128,
    systemPrompt: "Test.",
    contextWindow: null
  };
}

async function drain(stream: AsyncIterable<string>): Promise<void> {
  for await (const _chunk of stream) {
    // Drain.
  }
}

async function collect(stream: AsyncIterable<string>): Promise<string> {
  let result = "";
  for await (const chunk of stream) result += chunk;
  return result;
}

function openAiDelta(content: string): string {
  return `data: ${JSON.stringify({
    choices: [{ delta: { content } }]
  })}\n\n`;
}

function anthropicDelta(text: string): string {
  return `data: ${JSON.stringify({
    type: "content_block_delta",
    delta: { type: "text_delta", text }
  })}\n\n`;
}
