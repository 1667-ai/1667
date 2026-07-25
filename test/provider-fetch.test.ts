import assert from "node:assert/strict";
import { createServer } from "node:http";
import { isIP, type AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import test from "node:test";
import {
  ownedLoopbackFetch,
  ownedLoopbackHttpSupported,
  providerFetch,
  providerFetchWithPresetQuery
} from "../server/provider-fetch.js";
import { PinnedAddressAgent } from "../server/provider-private-http.js";
import { streamCompletion } from "../server/providers.js";
import type { PromptPlan } from "../shared/prompt-plan.js";

test("owned loopback HTTP verifies the exact current-account socket", {
  skip: !ownedLoopbackHttpSupported()
}, async (t) => {
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    assert.equal(request.url, "/v1/models");
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"data":');
    response.end("[]}");
  });
  const origin = await listen(t, server);

  const response = await providerFetch(`${origin}/v1/models`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: [] });
  assert.equal(requests, 1);
});

test("owned loopback HTTP permits an explicitly composed preset query", {
  skip: !ownedLoopbackHttpSupported()
}, async (t) => {
  const server = createServer((request, response) => {
    assert.equal(
      request.url,
      "/props?model=..%2Fmodels%2Fstory.gguf&autoload=false"
    );
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"default_generation_settings":{"n_ctx":4096}}');
  });
  const origin = await listen(t, server);
  const propsUrl = new URL(`${origin}/props`);
  propsUrl.searchParams.set("model", "../models/story.gguf");
  propsUrl.searchParams.set("autoload", "false");

  const response = await providerFetchWithPresetQuery(propsUrl);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    default_generation_settings: { n_ctx: 4096 }
  });
});

test("owned loopback HTTP closes a different-account socket before HTTP bytes", {
  skip: typeof process.getuid !== "function"
}, async (t) => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.end();
  });
  const origin = await listen(t, server);

  await assert.rejects(
    ownedLoopbackFetch(
      `${origin}/v1/models`,
      {},
      async () => process.getuid!() + 1
    ),
    /different account/
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(requests, 0);
});

test("owned loopback HTTP tolerates transient owner-table mismatch but requires two proofs", {
  skip: typeof process.getuid !== "function"
}, async (t) => {
  let requests = 0;
  let lookups = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.end("ready");
  });
  const origin = await listen(t, server);
  const uid = process.getuid!();

  const response = await ownedLoopbackFetch(origin, {}, async () => {
    lookups += 1;
    return lookups === 1 ? uid + 1 : uid;
  });

  assert.equal(await response.text(), "ready");
  assert.equal(lookups, 3);
  assert.equal(requests, 1);
});

test("owned loopback HTTP rejects credentials before opening a request", async () => {
  const cases = [
    {
      url: "http://127.0.0.1:1/v1/models",
      init: { headers: { authorization: "Bearer secret" } },
      message: /cannot carry authentication/
    },
    {
      url: "http://127.0.0.1:1/v1/models",
      init: { headers: { "x-secret-tenant": "secret" } },
      message: /cannot carry custom headers/
    },
    {
      url: "http://user:secret@127.0.0.1:1/v1/models",
      init: {},
      message: /cannot contain credentials/
    },
    {
      url: "http://127.0.0.1:1/v1/models?token=secret",
      init: {},
      message: /cannot contain credentials, a query, or a fragment/
    },
    {
      url: "http://127.0.0.1:1/v1/models?",
      init: {},
      message: /cannot contain credentials, a query, or a fragment/
    }
  ] as const;
  for (const fixture of cases) {
    await assert.rejects(
      ownedLoopbackFetch(
        fixture.url,
        fixture.init,
        async () => process.getuid?.() ?? 0
      ),
      fixture.message
    );
  }
});

test("provider requests never follow redirects", {
  skip: !ownedLoopbackHttpSupported()
}, async (t) => {
  let redirectedRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === "/redirected") redirectedRequests += 1;
    response.writeHead(302, { location: "/redirected" });
    response.end();
  });
  const origin = await listen(t, server);

  const response = await providerFetch(`${origin}/start`);

  assert.equal(response.status, 302);
  assert.equal(redirectedRequests, 0);
});

test("owned loopback HTTP rejects protocol upgrades instead of hanging", {
  skip: !ownedLoopbackHttpSupported()
}, async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(101, {
      connection: "upgrade",
      upgrade: "fixture"
    });
    response.end();
  });
  const origin = await listen(t, server);

  await assert.rejects(
    providerFetch(`${origin}/upgrade`, {
      signal: AbortSignal.timeout(1_000)
    }),
    /unsupported HTTP protocol upgrade/
  );
});

test("private-LAN HTTP requires opt-in and pins the numeric peer", async (t) => {
  const address = privateIpv4Address();
  if (address === null) {
    t.skip("no private IPv4 interface is available");
    return;
  }
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.end("private-ready");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, address, resolve);
  });
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  }));
  const port = (server.address() as AddressInfo).port;
  const url = `http://${address}:${port}/v1/models`;

  await assert.rejects(providerFetch(url), /require a loopback endpoint/);
  assert.equal(requests, 0);

  const response = await providerFetch(url, {}, { allowInsecurePrivateHttp: true });
  assert.equal(await response.text(), "private-ready");
  assert.equal(requests, 1);

  await assert.rejects(
    providerFetch(`${url}?model=fixture`, {}, { allowInsecurePrivateHttp: true }),
    /without credentials, query, or fragment/
  );
  assert.equal(requests, 1);

  const queried = await providerFetchWithPresetQuery(
    `${url}?model=fixture&autoload=false`,
    {},
    { allowInsecurePrivateHttp: true }
  );
  assert.equal(await queried.text(), "private-ready");
  assert.equal(requests, 2);
});

test("private HTTP agent destroys sockets that have not connected yet", async () => {
  const agent = new PinnedAddressAgent("192.0.2.1");
  const completed = new Promise<Error | null>((resolve) => {
    assert.equal(agent.createConnection({
      host: "192.0.2.1",
      port: 9
    }, (error) => resolve(error)), null);
  });

  agent.destroy();

  assert.match((await completed)?.message ?? "", /connection was closed/);
});

test("keyless owned-loopback generation streams through the provider adapter", {
  skip: !ownedLoopbackHttpSupported()
}, async (t) => {
  const server = createServer((request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/chat/completions");
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end([
      'data: {"choices":[{"delta":{"content":"local"}}]}',
      'data: {"choices":[{"delta":{"content":" model"}}]}',
      "data: [DONE]",
      "",
      ""
    ].join("\n\n"));
  });
  const origin = await listen(t, server);
  const prompt: PromptPlan = {
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
  let output = "";
  for await (const delta of streamCompletion({
    provider: "openai-compatible",
    baseUrl: `${origin}/v1`,
    model: "fixture",
    apiKeyEnv: null,
    temperature: 0,
    maxTokens: 32,
    systemPrompt: "Test.",
    contextWindow: null
  }, prompt, new AbortController().signal)) output += delta;

  assert.equal(output, "local model");
});

async function listen(
  t: test.TestContext,
  server: ReturnType<typeof createServer>
): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  }));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function privateIpv4Address(): string | null {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (
        entry.family === "IPv4"
        && !entry.internal
        && isIP(entry.address) === 4
        && (
          entry.address.startsWith("10.")
          || entry.address.startsWith("192.168.")
          || /^172\\.(?:1[6-9]|2[0-9]|3[01])\\./u.test(entry.address)
        )
      ) return entry.address;
    }
  }
  return null;
}
