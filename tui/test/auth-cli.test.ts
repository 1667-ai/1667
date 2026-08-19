import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "bun:test";
import type { AuthInteraction, Credential } from "@earendil-works/pi-ai";
import {
  clearAuthCliDependencies,
  configureAuthCliDependencies,
  createTerminalAuthInteraction,
  parseAuthCommand,
  runAuthCommand,
  type AuthCliDependencies,
  type AuthCliOutput
} from "../src/auth-cli.js";
import {
  SUBSCRIPTION_SECRET_IDS,
  createSubscriptionCredentialStore
} from "../../server/subscription-credential-store.js";
import { modifySubscriptionProviderSecret } from "../../server/provider-secret-store.js";
import { PROVIDER_SECRETS_FILE } from "../../server/data-directory-layout.js";

test("login requires confirmation before it calls Pi Models.login", async () => {
  const output = collector();
  let loginCalls = 0;
  const dependencies = fakeDependencies({
    login: async (provider, type, interaction) => {
      loginCalls += 1;
      assert.equal(provider, "openai-codex");
      assert.equal(type, "oauth");
      assert.equal(interaction, injectedInteraction);
      return oauthCredential(Date.now() + 1_000);
    }
  });
  const injectedInteraction = fakeInteraction();

  await runAuthCommand(["login", "chatgpt"], {
    dependencies,
    confirm: async () => false,
    interaction: injectedInteraction,
    streams: { output: output.stream }
  });

  assert.equal(loginCalls, 0);
  assert.match(output.text(), /experimental community integration/iu);
  assert.match(output.text(), /subscription limits/iu);
  assert.match(output.text(), /story text and generated text/iu);
  assert.match(output.text(), /API key connection/iu);
  assert.match(output.text(), /cancelled/iu);
});

test("TTY confirmation shows its question and accepts yes", async () => {
  const streams = ttyPromptStreams();
  let loginCalls = 0;
  const dependencies = fakeDependencies({
    login: async () => {
      loginCalls += 1;
      return oauthCredential(Date.now() + 1_000);
    }
  });

  const run = runAuthCommand(["login", "chatgpt"], {
    dependencies,
    streams: { input: streams.input, output: streams.output }
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  streams.inputStream.write("y\n");
  await run;

  const text = streams.text();
  assert.equal(loginCalls, 1);
  assert.match(text, /data controls\.\n/iu);
  assert.match(text, /Continue with ChatGPT sign-in\? \[y\/N\]/iu);
  streams.inputStream.destroy();
  streams.outputStream.destroy();
});

test("TTY confirmation keeps empty input as no", async () => {
  const streams = ttyPromptStreams();
  let loginCalls = 0;
  const dependencies = fakeDependencies({
    login: async () => {
      loginCalls += 1;
      return oauthCredential(Date.now() + 1_000);
    }
  });

  const run = runAuthCommand(["login", "claude"], {
    dependencies,
    streams: { input: streams.input, output: streams.output }
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  streams.inputStream.write("\n");
  await run;

  const text = streams.text();
  assert.equal(loginCalls, 0);
  assert.match(text, /Continue with Claude sign-in\? \[y\/N\]/iu);
  assert.match(text, /Sign-in cancelled\. Existing local credential was not changed\./iu);
  streams.inputStream.destroy();
  streams.outputStream.destroy();
});

test("confirmed login passes the injected interaction and selects only its provider", async () => {
  const output = collector();
  const injectedInteraction = fakeInteraction();
  const calls: string[] = [];
  const dependencies = fakeDependencies({
    login: async (provider, type, interaction) => {
      calls.push(`${provider}:${type}`);
      assert.equal(interaction, injectedInteraction);
      return oauthCredential(Date.now() + 1_000);
    }
  });

  await runAuthCommand(["login", "claude"], {
    dependencies,
    confirm: async () => true,
    interaction: injectedInteraction,
    streams: { output: output.stream }
  });

  assert.deepEqual(calls, ["anthropic:oauth"]);
  assert.match(output.text(), /Claude sign-in complete/iu);
});

test("prompt cancellation reports a cancelled sign-in without provider text", async () => {
  const output = collector();
  const promptStreams = ttyPromptStreams();
  const controller = new AbortController();
  const interaction = createTerminalAuthInteraction(
    promptStreams.input,
    promptStreams.output
  );
  const dependencies = fakeDependencies({
    login: async (_provider, _type, receivedInteraction) => {
      assert.equal(receivedInteraction, interaction);
      await receivedInteraction.prompt({
        type: "manual_code",
        message: "Paste the authorization code",
        signal: controller.signal
      });
      return oauthCredential(Date.now() + 1_000);
    }
  });

  const run = runAuthCommand(["login", "claude"], {
    dependencies,
    confirm: async () => true,
    interaction,
    streams: { output: output.stream }
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  await run;

  assert.match(output.text(), /Sign-in cancelled\. Existing local credential was not changed\./iu);
  assert.doesNotMatch(output.text(), /Could not sign in|access=|refresh=/iu);
  promptStreams.inputStream.destroy();
  promptStreams.outputStream.destroy();
});

test("status reads credentials without calling a refresh-capable Models method", async () => {
  const output = collector();
  const reads: string[] = [];
  let logoutCalls = 0;
  const dependencies = fakeDependencies({
    read: async (provider) => {
      reads.push(provider);
      if (provider === "openai-codex") {
        return oauthCredential(Date.now() + 60_000);
      }
      return oauthCredential(Date.now() - 60_000);
    },
    logout: async () => {
      logoutCalls += 1;
    }
  });

  await runAuthCommand(["status"], {
    dependencies,
    streams: { output: output.stream }
  });

  assert.deepEqual(reads, ["openai-codex", "anthropic"]);
  assert.equal(logoutCalls, 0);
  assert.match(output.text(), /ChatGPT: signed in/iu);
  assert.match(output.text(), /Claude: signed in \(refreshes on next use\)/iu);
  assert.doesNotMatch(output.text(), /test-access-secret|test-refresh-secret/iu);
});

test("logout removes only the selected local credential and states revocation limits", async () => {
  const output = collector();
  const providers: string[] = [];
  const dependencies = fakeDependencies({
    logout: async (provider) => {
      providers.push(provider);
    }
  });

  await runAuthCommand(["logout", "chatgpt"], {
    dependencies,
    streams: { output: output.stream }
  });

  assert.deepEqual(providers, ["openai-codex"]);
  assert.match(output.text(), /removed from this machine/iu);
  assert.match(output.text(), /remote token revocation is not promised/iu);
});

test("provider errors use fixed public text and never expose credential values", async () => {
  const output = collector();
  const dependencies = fakeDependencies({
    login: async () => {
      const error = new Error("access=access-secret refresh=refresh-secret");
      error.name = "AbortError";
      throw error;
    }
  });

  await assert.rejects(
    runAuthCommand(["login", "claude"], {
      dependencies,
      confirm: async () => true,
      streams: { output: output.stream }
    }),
    (error: unknown) => {
      assert(error instanceof Error);
      assert.match(error.message, /Could not sign in to Claude/iu);
      assert.doesNotMatch(error.message, /access-secret|refresh-secret/iu);
      return true;
    }
  );
});

test("Pi auth events are rendered as plain terminal text", () => {
  const output = collector(true);
  const interaction = createTerminalAuthInteraction(
    { isTTY: false } as NodeJS.ReadStream,
    output.stream
  );
  interaction.notify({
    type: "auth_url",
    url: "https://login.example.test/continue",
    instructions: "Finish sign-in, then return here."
  });
  interaction.notify({
    type: "device_code",
    verificationUri: "https://login.example.test/device",
    userCode: "ABCD-EFGH"
  });
  interaction.notify({ type: "progress", message: "Waiting for sign-in." });

  assert.match(output.text(), /https:\/\/login\.example\.test\/continue/iu);
  assert.match(output.text(), /\u001b\]8;;https:\/\/login\.example\.test\/continue/iu);
  assert.match(output.text(), /1667 does not open a browser/iu);
  assert.doesNotMatch(output.text(), /Finish sign-in, then return here/iu);
  assert.match(output.text(), /ABCD-EFGH/u);
  assert.match(output.text(), /Waiting for sign-in/iu);
});

test("provider auth text marks terminal control characters", async () => {
  const control = "\u001b[31mprovider\u0007";
  const output = collector();
  const interaction = createTerminalAuthInteraction(
    { isTTY: false } as NodeJS.ReadStream,
    output.stream
  );
  interaction.notify({
    type: "info",
    message: `Info ${control}`,
    links: [{ label: `Label ${control}`, url: `https://example.test/${control}` }]
  });
  interaction.notify({
    type: "auth_url",
    url: `https://login.example.test/continue/${control}`,
    instructions: `Instructions ${control}`
  });
  interaction.notify({
    type: "device_code",
    verificationUri: `https://login.example.test/device/${control}`,
    userCode: `Code ${control}`
  });
  interaction.notify({ type: "progress", message: `Progress ${control}` });

  const text = output.text();
  assert.doesNotMatch(text, /\u001b|\u0007/u);
  assert.match(text, /Info ▪\[31mprovider▪/u);
  assert.match(text, /Label ▪\[31mprovider▪: https:\/\/example\.test\/▪\[31mprovider▪/u);
  assert.match(text, /https:\/\/login\.example\.test\/continue\/▪\[31mprovider▪/u);
  assert.match(text, /https:\/\/login\.example\.test\/device\/▪\[31mprovider▪/u);
  assert.doesNotMatch(text, /Instructions/u);
  assert.match(text, /Code ▪\[31mprovider▪/u);
  assert.match(text, /Progress ▪\[31mprovider▪/u);

  const promptStreams = ttyPromptStreams();
  const promptInteraction = createTerminalAuthInteraction(
    promptStreams.input,
    promptStreams.output
  );
  const pending = promptInteraction.prompt({
    type: "select",
    message: `Choose ${control}`,
    options: [{ id: "ok", label: `Label ${control}`, description: `Detail ${control}` }]
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  promptStreams.inputStream.write("1\n");
  assert.equal(await pending, "ok");
  const promptText = promptStreams.text();
  const providerPromptText = promptText.split("\u001b", 1)[0]!;
  assert.doesNotMatch(providerPromptText, /\u001b|\u0007/u);
  assert.match(providerPromptText, /Choose ▪\[31mprovider▪/u);
  assert.match(providerPromptText, /Label ▪\[31mprovider▪/u);
  assert.match(providerPromptText, /Detail ▪\[31mprovider▪/u);
  promptStreams.inputStream.destroy();
  promptStreams.outputStream.destroy();

  const manualStreams = ttyPromptStreams();
  const manualInteraction = createTerminalAuthInteraction(
    manualStreams.input,
    manualStreams.output
  );
  const manualPending = manualInteraction.prompt({
    type: "manual_code",
    message: `Code ${control}`,
    placeholder: `Redirect ${control}`
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  manualStreams.inputStream.write("authorization-code\n");
  assert.equal(await manualPending, "authorization-code");
  const manualPromptText = manualStreams.text();
  assert.match(manualPromptText, /Code ▪\[31mprovider▪ \(Redirect ▪\[31mprovider▪\):/u);
  manualStreams.inputStream.destroy();
  manualStreams.outputStream.destroy();

  const secretStreams = ttyPromptStreams();
  Object.assign(secretStreams.inputStream, { setRawMode: () => {} });
  const secretInteraction = createTerminalAuthInteraction(
    secretStreams.input,
    secretStreams.output
  );
  const secretPending = secretInteraction.prompt({
    type: "secret",
    message: `Secret ${control}`,
    placeholder: `Hidden ${control}`
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  secretStreams.inputStream.write("secret-value\n");
  assert.equal(await secretPending, "secret-value");
  const secretPromptText = secretStreams.text();
  assert.doesNotMatch(secretPromptText, /\u001b|\u0007/u);
  assert.match(secretPromptText, /Secret ▪\[31mprovider▪ \(Hidden ▪\[31mprovider▪\):/u);
  secretStreams.inputStream.destroy();
  secretStreams.outputStream.destroy();
});

test("status maps invalid injected credentials to signed out", async () => {
  const output = collector();
  await runAuthCommand(["status"], {
    dependencies: fakeDependencies({
      read: async () => ({
        type: "oauth",
        access: "",
        refresh: "",
        expires: Number.NaN
      })
    }),
    streams: { output: output.stream }
  });

  assert.equal(output.text(), "ChatGPT: signed out\nClaude: signed out\n");
  assert.doesNotMatch(output.text(), /expired|refreshes/iu);
});

test("status continues after a corrupt ChatGPT envelope", async () => {
  const secretsDir = await mkdtemp(path.join(tmpdir(), "1667-auth-corrupt-"));
  const accessSecret = "corrupt-chatgpt-access-secret";
  const refreshSecret = "corrupt-chatgpt-refresh-secret";
  try {
    await modifySubscriptionProviderSecret(
      secretsDir,
      SUBSCRIPTION_SECRET_IDS["openai-codex"],
      () => JSON.stringify({
        format: "1667-subscription-credential",
        version: 1,
        provider: "openai-codex",
        credential: {
          type: "oauth",
          access: accessSecret,
          refresh: refreshSecret,
          expires: Date.now() + 60_000,
          unexpected: true
        }
      })
    );
    const credentials = createSubscriptionCredentialStore(secretsDir);
    await credentials.modify("anthropic", async () => oauthCredential(Date.now() + 60_000));
    const output = collector();

    await runAuthCommand(["status"], {
      dependencies: fakeDependencies({ read: credentials.read.bind(credentials) }),
      streams: { output: output.stream }
    });

    assert.equal(output.text(), "ChatGPT: signed out\nClaude: signed in\n");
    assert.doesNotMatch(output.text(), /corrupt-chatgpt-(access|refresh)-secret/iu);
  } finally {
    await rm(secretsDir, { recursive: true, force: true });
  }
});

test("status treats an oversized ChatGPT envelope as signed out", async () => {
  const secretsDir = await mkdtemp(path.join(tmpdir(), "1667-auth-oversized-"));
  const oversized = "x".repeat(16 * 1024 + 1);
  const validClaude = JSON.stringify({
    format: "1667-subscription-credential",
    version: 1,
    provider: "anthropic",
    credential: {
      type: "oauth",
      access: "valid-claude-access-secret",
      refresh: "valid-claude-refresh-secret",
      expires: Date.now() + 60_000
    }
  });
  try {
    await writeFile(
      path.join(secretsDir, PROVIDER_SECRETS_FILE),
      JSON.stringify({
        [SUBSCRIPTION_SECRET_IDS["openai-codex"]]: oversized,
        [SUBSCRIPTION_SECRET_IDS.anthropic]: validClaude
      }),
      { mode: 0o600 }
    );
    const credentials = createSubscriptionCredentialStore(secretsDir);
    const output = collector();

    await runAuthCommand(["status"], {
      dependencies: fakeDependencies({ read: credentials.read.bind(credentials) }),
      streams: { output: output.stream }
    });

    assert.equal(output.text(), "ChatGPT: signed out\nClaude: signed in\n");
    assert.doesNotMatch(output.text(), /valid-claude-(access|refresh)-secret|oversized/iu);
    await credentials.delete("openai-codex");
    assert.equal(await credentials.read("openai-codex"), undefined);
  } finally {
    await rm(secretsDir, { recursive: true, force: true });
  }
});

test("status still fails on a credential read error", async () => {
  await assert.rejects(
    runAuthCommand(["status"], {
      dependencies: fakeDependencies({
        read: async () => { throw new Error("permission denied"); }
      }),
      streams: { output: collector().stream }
    }),
    /Could not read ChatGPT sign-in status/iu
  );
});

test("auth parser directs unknown commands to auth help", () => {
  assert.throws(() => parseAuthCommand([]), /auth --help/iu);
  assert.throws(() => parseAuthCommand(["unknown"]), /auth show/iu);
});

test("manual OAuth code prompt honors abort and closes its readline", async () => {
  const input = new PassThrough();
  Object.assign(input, { isTTY: true });
  const outputStream = new PassThrough();
  const outputChunks: string[] = [];
  outputStream.on("data", (chunk: Buffer) => outputChunks.push(chunk.toString("utf8")));
  const output = Object.assign(outputStream, { isTTY: true }) as unknown as AuthCliOutput;
  const controller = new AbortController();
  const interaction = createTerminalAuthInteraction(
    input as unknown as NodeJS.ReadStream,
    output
  );

  const pending = interaction.prompt({
    type: "manual_code",
    message: "Paste the authorization code",
    signal: controller.signal
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.match(outputChunks.join(""), /Paste the authorization code/iu);
  controller.abort();

  await assert.rejects(pending, /abort/iu);
  assert.equal(input.readableFlowing, false);
  assert.equal(input.listenerCount("error"), 0);
  assert.equal(input.listenerCount("end"), 0);
  input.destroy();
});

test("select prompt uses its first option when Enter is empty", async () => {
  const streams = ttyPromptStreams();
  const interaction = createTerminalAuthInteraction(streams.input, streams.output);
  const pending = interaction.prompt({
    type: "select",
    message: "Choose a login method",
    options: [
      { id: "browser", label: "Browser login" },
      { id: "device", label: "Device code login" }
    ]
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  streams.inputStream.write("\n");

  assert.equal(await pending, "browser");
  assert.equal((streams.text().match(/Browser login/g) ?? []).length, 1);
  streams.inputStream.destroy();
  streams.outputStream.destroy();
});

test("select prompt retries an invalid choice without repeating its options", async () => {
  const streams = ttyPromptStreams();
  const interaction = createTerminalAuthInteraction(streams.input, streams.output);
  const pending = interaction.prompt({
    type: "select",
    message: "Choose a login method",
    options: [
      { id: "browser", label: "Browser login" },
      { id: "device", label: "Device code login" }
    ]
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  streams.inputStream.write("9\n");
  await waitForOutput(streams, "Choose a listed option.");
  streams.inputStream.write("2\n");

  assert.equal(await pending, "device");
  const text = streams.text();
  assert.equal((text.match(/Browser login/g) ?? []).length, 1);
  assert.equal((text.match(/Choose a listed option\./g) ?? []).length, 1);
  streams.inputStream.destroy();
  streams.outputStream.destroy();
});

test("auth parser accepts only the supported commands", () => {
  assert.deepEqual(parseAuthCommand(["status"]), { action: "status" });
  assert.deepEqual(parseAuthCommand(["login", "chatgpt"]), {
    action: "login",
    provider: "chatgpt"
  });
  assert.throws(() => parseAuthCommand(["login", "openai"]), /chatgpt or claude/iu);
  assert.throws(() => parseAuthCommand(["status", "--refresh"]), /does not accept options/iu);
});

test("main dispatches auth status without opening a story project", async () => {
  const dependencies = fakeDependencies({
    read: async (provider) => provider === "openai-codex"
      ? oauthCredential(Date.now() + 60_000)
      : undefined
  });
  const originalWrite = process.stdout.write;
  const chunks: string[] = [];
  process.stdout.write = ((chunk: string) => {
    chunks.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  configureAuthCliDependencies(dependencies);
  try {
    const { main } = await import("../src/main.js");
    await main(["auth", "status"]);
  } finally {
    clearAuthCliDependencies();
    process.stdout.write = originalWrite;
  }
  assert.match(chunks.join(""), /ChatGPT: signed in/iu);
  assert.match(chunks.join(""), /Claude: signed out/iu);
});

test("1667 auth status treats an absent machine-tier directory as signed out", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-auth-status-"));
  const absentMachineTier = path.join(root, "machine-state");
  try {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("../bin/1667", import.meta.url)), "auth", "status"],
      {
        env: { ...process.env, AI_1667_STATE: absentMachineTier },
        encoding: "utf8",
        timeout: 10_000
      }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ChatGPT: signed out/iu);
    assert.match(result.stdout, /Claude: signed out/iu);
    assert.equal(result.stderr, "");
    assert.equal(await pathExists(absentMachineTier), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function fakeInteraction(): AuthInteraction {
  return {
    prompt: async () => "",
    notify: () => {}
  };
}

function oauthCredential(expires: number): Credential {
  return {
    type: "oauth",
    access: "test-access-secret",
    refresh: "test-refresh-secret",
    expires
  };
}

function fakeDependencies(
  overrides: Partial<{
    login: AuthCliDependencies["models"]["login"];
    logout: AuthCliDependencies["models"]["logout"];
    read: AuthCliDependencies["credentials"]["read"];
  }> = {}
): AuthCliDependencies {
  return {
    models: {
      login: overrides.login ?? (async () => oauthCredential(Date.now() + 1_000)),
      logout: overrides.logout ?? (async () => {})
    },
    credentials: {
      read: overrides.read ?? (async () => undefined)
    }
  };
}

function collector(isTTY = false): { readonly stream: AuthCliOutput; readonly text: () => string } {
  const chunks: string[] = [];
  return {
    stream: { isTTY, write: (text) => { chunks.push(String(text)); } },
    text: () => chunks.join("")
  };
}

function ttyPromptStreams(): {
  readonly input: NodeJS.ReadStream;
  readonly inputStream: PassThrough;
  readonly output: AuthCliOutput;
  readonly outputStream: PassThrough;
  readonly text: () => string;
} {
  const inputStream = new PassThrough();
  Object.assign(inputStream, { isTTY: true });
  const outputStream = new PassThrough();
  Object.assign(outputStream, { isTTY: true });
  const chunks: string[] = [];
  outputStream.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
  return {
    input: inputStream as unknown as NodeJS.ReadStream,
    inputStream,
    output: outputStream as unknown as AuthCliOutput,
    outputStream,
    text: () => chunks.join("")
  };
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function waitForOutput(
  streams: { readonly text: () => string },
  expected: string
): Promise<void> {
  for (;;) {
    if (streams.text().includes(expected)) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
