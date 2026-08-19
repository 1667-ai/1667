import assert from "node:assert/strict";
import test from "node:test";
import {
  type Models,
  type OAuthCredential
} from "@earendil-works/pi-ai";
import { ProviderError } from "../server/errors.js";
import { streamCompletion } from "../server/providers.js";
import {
  SUBSCRIPTION_SECRET_IDS,
  SubscriptionCredentialInvalidError,
  createSubscriptionCredentialStore
} from "../server/subscription-credential-store.js";
import { createSubscriptionModels } from "../server/subscription-models.js";
import {
  modifySubscriptionProviderSecret,
  readProviderSecrets,
  writeProviderSecret
} from "../server/provider-secret-store.js";
import { SettingsV2Store } from "../server/settings-v2-store.js";
import { convertGenerationSettingsV1 } from "../server/settings-v2-conversion.js";
import { parseSettingsDocumentV2 } from "../server/settings-v2-codec.js";
import type { GenerationSettings } from "../shared/types.js";
import {
  FIXED_TIME,
  MUTATION_A,
  initializedFormat2Directory,
  saveCommand
} from "./settings-store-fixtures.js";
import {
  ACCESS,
  PROMPT,
  REFRESH,
  collect,
  fakeModels,
  modelFor,
  oauth,
  subscriptionSettings,
  successfulStream,
  temporaryDirectory
} from "./subscription-adapter-test-helpers.js";

test("subscription credentials use strict envelopes and cross-call serialization", async (t) => {
  const secretsDir = await temporaryDirectory(t, "1667-subscription-credentials-");
  const credentialsA = createSubscriptionCredentialStore(secretsDir);
  const credentialsB = createSubscriptionCredentialStore(secretsDir);
  await credentialsA.modify("anthropic", async () => oauth(ACCESS));

  let active = 0;
  let maximum = 0;
  await Promise.all(["one", "two"].map((suffix, index) => [credentialsA, credentialsB][index]!.modify(
    "anthropic",
    async (current) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 2_100));
      active -= 1;
      return oauth(
        `${ACCESS}-${suffix}`,
        current?.type === "oauth" ? current.refresh : REFRESH
      );
    }
  )));
  assert.equal(maximum, 1);
  assert.equal((await credentialsA.read("anthropic"))?.type, "oauth");
  assert.deepEqual(await credentialsA.list(), [{ providerId: "anthropic", type: "oauth" }]);

  const raw = (await readProviderSecrets(secretsDir)).get(SUBSCRIPTION_SECRET_IDS.anthropic);
  assert.ok(raw?.includes('"format":"1667-subscription-credential"'));
  assert.ok(raw?.includes('"version":1'));

  const leaked = "secret-that-must-not-escape";
  await modifySubscriptionProviderSecret(
    secretsDir,
    SUBSCRIPTION_SECRET_IDS.anthropic,
    () => JSON.stringify({
      format: "1667-subscription-credential",
      version: 1,
      provider: "anthropic",
      credential: {
        type: "oauth",
        access: leaked,
        refresh: REFRESH,
        expires: Date.now() + 60_000,
        unexpected: true
      }
    })
  );
  await assert.rejects(
    credentialsA.read("anthropic"),
    (error: unknown) => error instanceof SubscriptionCredentialInvalidError
      && error.message === "Subscription credential operation failed"
      && !error.message.includes(leaked)
  );

  let currentSeenByLogin: unknown = "not-called";
  await credentialsA.modify("anthropic", async (current) => {
    currentSeenByLogin = current;
    return oauth(`${ACCESS}-recovered`);
  });
  assert.equal(currentSeenByLogin, undefined);
  const recovered = await credentialsA.read("anthropic");
  assert.equal(recovered?.type, "oauth");
  assert.equal(recovered?.type === "oauth" ? recovered.access : undefined, `${ACCESS}-recovered`);
});

test("subscription refresh locks leave unrelated provider secrets available", async (t) => {
  const secretsDir = await temporaryDirectory(t, "1667-subscription-lock-scope-");
  const credentialsA = createSubscriptionCredentialStore(secretsDir);
  const credentialsB = createSubscriptionCredentialStore(secretsDir);
  await credentialsA.modify("anthropic", async () => oauth(ACCESS));

  let active = 0;
  let maximum = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let firstStarted!: () => void;
  const firstMarker = new Promise<void>((resolve) => { firstStarted = resolve; });
  const first = credentialsA.modify("anthropic", async (current) => {
    active += 1;
    maximum = Math.max(maximum, active);
    firstStarted();
    await gate;
    active -= 1;
    return oauth(`${ACCESS}-first`, current?.type === "oauth" ? current.refresh : REFRESH);
  });
  await firstMarker;

  let secondEntered = false;
  const second = credentialsB.modify("anthropic", async (current) => {
    secondEntered = true;
    active += 1;
    maximum = Math.max(maximum, active);
    active -= 1;
    return oauth(`${ACCESS}-second`, current?.type === "oauth" ? current.refresh : REFRESH);
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondEntered, false);

  try {
    await writeProviderSecret(secretsDir, "ordinary:unrelated", "unrelated-value");
  } finally {
    release();
  }
  await Promise.all([first, second]);
  assert.equal(maximum, 1);
  assert.equal((await credentialsA.read("anthropic"))?.type, "oauth");
  assert.equal(
    (await readProviderSecrets(secretsDir)).get("ordinary:unrelated"),
    "unrelated-value"
  );
});

test("subscription refresh lock acquisition honors cancellation", async (t) => {
  const secretsDir = await temporaryDirectory(t, "1667-subscription-lock-cancel-");
  const credentialsA = createSubscriptionCredentialStore(secretsDir);
  const credentialsB = createSubscriptionCredentialStore(secretsDir);
  await credentialsA.modify("anthropic", async () => oauth(ACCESS));

  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const marker = new Promise<void>((resolve) => { started = resolve; });
  const first = credentialsA.modify("anthropic", async (current) => {
    started();
    await gate;
    return oauth(`${ACCESS}-first`, current?.type === "oauth" ? current.refresh : REFRESH);
  });
  await marker;

  const controller = new AbortController();
  const waiting = credentialsB.modify(
    "anthropic",
    async () => oauth(`${ACCESS}-should-not-publish`),
    { signal: controller.signal }
  );
  controller.abort();
  await assert.rejects(
    waiting,
    (error: unknown) => error instanceof Error && error.name === "AbortError"
  );
  release();
  await first;
  assert.equal((await credentialsA.read("anthropic"))?.type, "oauth");
});

test("subscription refresh persists a rotated credential before cancellation propagates", async (t) => {
  const secretsDir = await temporaryDirectory(t, "1667-subscription-refresh-commit-");
  const credentials = createSubscriptionCredentialStore(secretsDir);
  await credentials.modify("anthropic", async () => oauth(ACCESS));

  const controller = new AbortController();
  let release!: (credential: OAuthCredential) => void;
  let callbackStarted!: () => void;
  const started = new Promise<void>((resolve) => { callbackStarted = resolve; });
  const pending = credentials.modify("anthropic", async () => {
    callbackStarted();
    return await new Promise<OAuthCredential>((resolve) => { release = resolve; });
  }, { signal: controller.signal });
  await started;

  release(oauth(`${ACCESS}-rotated`, `${REFRESH}-rotated`));
  controller.abort();
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof Error && error.name === "AbortError"
  );

  const persisted = await credentials.read("anthropic");
  assert.equal(persisted?.type, "oauth");
  assert.equal(persisted?.type === "oauth" ? persisted.access : undefined, `${ACCESS}-rotated`);
  assert.equal(persisted?.type === "oauth" ? persisted.refresh : undefined, `${REFRESH}-rotated`);
});

test("subscription logout preserves ordinary legacy keys at both old IDs", async (t) => {
  const secretsDir = await temporaryDirectory(t, "1667-subscription-legacy-id-");
  const credentials = createSubscriptionCredentialStore(secretsDir);
  for (const [providerId, legacyId] of [
    ["openai-codex", "subscription-openai-codex"],
    ["anthropic", "subscription-anthropic"]
  ] as const) {
    await writeProviderSecret(secretsDir, legacyId, "legacy-ordinary-value");
    const credentialsBefore = await readProviderSecrets(secretsDir);
    assert.equal(credentialsBefore.get(legacyId), "legacy-ordinary-value");
    await assert.rejects(
      writeProviderSecret(secretsDir, SUBSCRIPTION_SECRET_IDS[providerId], "not-a-user-secret"),
      /must match/u
    );

    await credentials.modify(providerId, async () => oauth(`${ACCESS}-${providerId}`));
    const stored = await readProviderSecrets(secretsDir);
    assert.equal(stored.get(legacyId), "legacy-ordinary-value");
    assert.ok(stored.has(SUBSCRIPTION_SECRET_IDS[providerId]));

    await credentials.delete(providerId);
    const afterLogout = await readProviderSecrets(secretsDir);
    assert.equal(afterLogout.get(legacyId), "legacy-ordinary-value");
    assert.equal(afterLogout.has(SUBSCRIPTION_SECRET_IDS[providerId]), false);
  }
});

test("subscription auth ignores ambient API keys and redacts auth failures", async (t) => {
  const secretsDir = await temporaryDirectory(t, "1667-subscription-auth-");
  const credentials = createSubscriptionCredentialStore(secretsDir);
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = ACCESS;
  try {
    const models = createSubscriptionModels(credentials);
    const model = models.getModels("anthropic")[0];
    assert.ok(model);
    assert.equal(await models.getAuth(model!), undefined);
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
  }

  await credentials.modify("anthropic", async () => oauth(ACCESS));
  const fixture = modelFor("anthropic", "anthropic-messages");
  const modelsWithFailure = fakeModels(
    fixture,
    () => successfulStream(fixture, false),
    async () => { throw new Error(`OAuth response leaked ${ACCESS}`); }
  );
  const settings = subscriptionSettings(
    "anthropic-subscription-messages",
    "anthropic",
    "anthropic-messages",
    credentials,
    modelsWithFailure
  );
  await assert.rejects(
    collect(streamCompletion(settings, PROMPT, new AbortController().signal)),
    (error: unknown) => error instanceof ProviderError
      && error.message === "Claude plan authentication failed. Run 1667 auth login claude."
      && !error.message.includes(ACCESS)
  );
});

test("subscription auth errors use fixed plan labels and login commands", async (t) => {
  for (const fixture of [
    {
      providerId: "openai-codex" as const,
      provider: "openai-compatible" as const,
      protocol: "openai-codex-responses" as const,
      api: "openai-codex-responses" as const,
      label: "ChatGPT plan",
      login: "chatgpt"
    },
    {
      providerId: "anthropic" as const,
      provider: "anthropic" as const,
      protocol: "anthropic-subscription-messages" as const,
      api: "anthropic-messages" as const,
      label: "Claude plan",
      login: "claude"
    }
  ]) {
    const secretsDir = await temporaryDirectory(t, `1667-subscription-auth-presentation-${fixture.providerId}-`);
    const credentials = createSubscriptionCredentialStore(secretsDir);
    await credentials.modify(fixture.providerId, async () => oauth(ACCESS));
    const model = modelFor(fixture.providerId, fixture.api);
    const settingsFor = (models: Models): GenerationSettings => subscriptionSettings(
      fixture.protocol,
      fixture.provider,
      fixture.api,
      credentials,
      models
    );
    const expectedMissing = `${fixture.label} is not signed in. Run 1667 auth login ${fixture.login}.`;
    const missingModels = fakeModels(
      model,
      () => successfulStream(model, fixture.api === "anthropic-messages"),
      async () => undefined
    );
    await assert.rejects(
      collect(streamCompletion(settingsFor(missingModels), PROMPT, new AbortController().signal)),
      (error: unknown) => error instanceof ProviderError && error.message === expectedMissing
    );

    const leaked = `oauth-response-${fixture.providerId}-${ACCESS}`;
    const failedModels = fakeModels(
      model,
      () => successfulStream(model, fixture.api === "anthropic-messages"),
      async () => { throw new Error(leaked); }
    );
    const expectedFailure = `${fixture.label} authentication failed. Run 1667 auth login ${fixture.login}.`;
    await assert.rejects(
      collect(streamCompletion(settingsFor(failedModels), PROMPT, new AbortController().signal)),
      (error: unknown) => error instanceof ProviderError
        && error.message === expectedFailure
        && !error.message.includes(leaked)
    );
  }
});

test("subscription reserved secret IDs cannot become normal provider auth", () => {
  const base = convertGenerationSettingsV1({
    provider: "openai-compatible",
    baseUrl: "https://api.example.test/v1",
    model: "fixture-model",
    apiKeyEnv: null,
    temperature: 0,
    maxTokens: 128,
    systemPrompt: "Continue.",
    contextWindow: null
  });
  assert.throws(() => parseSettingsDocumentV2({
    ...base,
    connections: {
      ...base.connections,
      "migrated:connection": {
        ...base.connections["migrated:connection"]!,
        auth: { type: "bearer-stored", secretId: SUBSCRIPTION_SECRET_IDS.anthropic }
      }
    }
  }));
});

test("settings pruning keeps machine-owned subscription credentials", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-subscription-prune-");
  const credentials = createSubscriptionCredentialStore(dataDir);
  await credentials.modify("anthropic", async () => oauth(ACCESS));
  const store = new SettingsV2Store(dataDir, { now: () => FIXED_TIME });
  await store.init();
  assert.equal((await credentials.read("anthropic"))?.type, "oauth");

  const base = convertGenerationSettingsV1({
    provider: "openai-compatible",
    baseUrl: "https://api.example.test/v1",
    model: "fixture-model",
    apiKeyEnv: null,
    temperature: 0,
    maxTokens: 128,
    systemPrompt: "Continue.",
    contextWindow: null
  });
  const candidate = parseSettingsDocumentV2({
    ...base,
    connections: {
      ...base.connections,
      "migrated:connection": {
        ...base.connections["migrated:connection"]!,
        name: "ChatGPT plan",
        preset: "chatgpt-plan",
        protocol: "openai-codex-responses",
        baseUrl: null,
        auth: { type: "none" },
        headers: []
      }
    }
  });
  const saved = await store.save(saveCommand(MUTATION_A, 1, candidate));
  assert.equal(saved.activationOutcome?.result, "committed");
});
