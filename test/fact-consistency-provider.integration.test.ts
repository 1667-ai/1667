import assert from "node:assert/strict";
import {
  LEGACY_PROMPT_CACHE_CONTEXT,
  PromptCacheRuntime
} from "../server/provider-cache-policy.js";
import type { SettingsStore } from "../server/settings.js";
import { ProviderError, ServiceError } from "../server/errors.js";
import { StoryServiceFactConsistency } from "../server/story-service-fact-consistency.js";
import type { GenerationSettings, Story } from "../shared/types.js";
import {
  MAX_FACT_CONSISTENCY_PART_CHARS,
  MAX_FACT_CONSISTENCY_LINE_TAKES
} from "../shared/fact-consistency-types.js";
import { MAX_FACT_CONSISTENCY_PROVIDER_REQUESTS } from "../server/fact-consistency-bounds.js";
import {
  fakeModel,
  modelSettings,
  providerTest,
  stream
} from "./provider-http-fixture.js";
import {
  OTHER_FINGERPRINT,
  OTHER_MUTATION_ID,
  providerOperation,
  request,
  requestFor,
  setup,
  STORY_ID,
  storyFixture
} from "./story-mutation-fixtures.js";

providerTest("Fact consistency requires the confirmed plan and rejects plan drift", async (t) => {
  const model = await fakeModel(t, (_body, response) => {
    throw new Error("a stale or missing plan must not reach the provider");
  });
  const fixture = await setup(t, "1667-fact-consistency-plan-binding-");
  await seedFactStory(fixture, factStory(20, 1));
  const service = factConsistencyService(fixture, modelSettings(model.baseUrl));
  const input = {
    storyId: STORY_ID,
    focusedPartId: "root",
    scope: "story-line" as const
  };

  await assert.rejects(
    service.check(input, new AbortController().signal),
    (error: unknown) => {
      assert.ok(error instanceof ServiceError);
      assert.equal(error.status, 400);
      assert.equal(error.code, "invalid_request");
      assert.match(error.message, /requires the current plan token/u);
      return true;
    }
  );

  const plan = await service.plan(input);
  const version = (await fixture.stories.loadVersioned(STORY_ID)).aggregateVersion!;
  await fixture.mutations.runLocal(
    requestFor(OTHER_MUTATION_ID, OTHER_FINGERPRINT, version),
    "editNode",
    (story) => { story.nodes[0]!.text = "The changed prose invalidates the confirmed plan."; }
  );
  await assert.rejects(
    service.check({ ...input, planToken: plan.planToken }, new AbortController().signal),
    (error: unknown) => {
      assert.ok(error instanceof ServiceError);
      assert.equal(error.status, 409);
      assert.equal(error.code, "conflict");
      assert.match(error.message, /plan is stale/u);
      return true;
    }
  );
  assert.equal(model.requests.length, 0);
});

providerTest("Fact consistency splits whole Fact States and keeps one run", async (t) => {
  const model = await fakeModel(t, (body, response) => {
    const prompt = requestPrompt(body);
    const marker = completionMarker(prompt);
    stream(response, [`NONE\n${marker}`]);
  });
  const fixture = await setup(t, "1667-fact-consistency-provider-");
  await seedFactStory(fixture, factStory(400, 2));
  const settings = {
    ...modelSettings(model.baseUrl),
    temperature: 0.9,
    contextWindow: 478
  };
  const service = factConsistencyService(fixture, settings);

  const input = {
    storyId: STORY_ID,
    focusedPartId: "root",
    scope: "story-line"
  } as const;
  const plan = await service.plan(input);
  assert.equal(plan.partCount, 1);
  assert.equal(plan.requestCount, 2);
  assert.match(plan.planToken, /^[a-f0-9]{64}$/u);

  const result = await service.check({
    ...input,
    planToken: plan.planToken
  }, new AbortController().signal);

  assert.equal(model.requests.length, 2);
  for (const request of model.requests) {
    const prompt = requestPrompt(request);
    assert.match(prompt, /Mira crossed the square\. The bell rang\./u);
    assert.equal((prompt.match(/Fact State 1/gu) ?? []).length, 1);
    assert.doesNotMatch(prompt, /Fact State 2/u);
    assert.equal(request.temperature, 0.2);
  }
  assert.equal(result.run.parts.length, 1);
  assert.equal(result.run.parts[0]!.uncheckedReason, undefined);
  assert.equal(result.payload.hasFactConsistencyRun, true);
  assert.deepEqual(await service.getRun(STORY_ID), result.run);
});

providerTest("Fact consistency rejects an overlong line before provider admission", async (t) => {
  const model = await fakeModel(t, (_body, response) => {
    stream(response, [`NONE\n${completionMarker("unused")}`]);
  });
  const fixture = await setup(t, "1667-fact-consistency-line-limit-");
  await seedFactStory(fixture, factStory(20, 1, MAX_FACT_CONSISTENCY_LINE_TAKES + 1));
  const service = factConsistencyService(fixture, modelSettings(model.baseUrl));

  await assert.rejects(
    service.plan({
      storyId: STORY_ID,
      focusedPartId: "root",
      scope: "story-line"
    }),
    (error: unknown) => {
      assert.ok(error instanceof ServiceError);
      assert.equal(error.status, 400);
      assert.equal(error.code, "invalid_request");
      assert.match(error.message, /at most 5,000 parts/u);
      return true;
    }
  );
  assert.equal(model.requests.length, 0);
});

providerTest("Fact consistency rejects excessive provider work before provider admission", async (t) => {
  const model = await fakeModel(t, (_body, response) => {
    stream(response, [`NONE\n${completionMarker("unused")}`]);
  });
  const fixture = await setup(t, "1667-fact-consistency-request-limit-");
  await seedFactStory(fixture, factStory(20, 1, MAX_FACT_CONSISTENCY_PROVIDER_REQUESTS + 1));
  const service = factConsistencyService(fixture, modelSettings(model.baseUrl));

  await assert.rejects(
    service.plan({
      storyId: STORY_ID,
      focusedPartId: "root",
      scope: "story-line"
    }),
    (error: unknown) => {
      assert.ok(error instanceof ServiceError);
      assert.equal(error.status, 400);
      assert.equal(error.code, "invalid_request");
      assert.match(error.message, /at most 1,024 provider requests/u);
      return true;
    }
  );
  assert.equal(model.requests.length, 0);
});

providerTest("Fact consistency skips an overlong part before provider dispatch", async (t) => {
  const model = await fakeModel(t, (_body, response) => {
    throw new Error("an overlong part must not reach the provider");
  });
  const fixture = await setup(t, "1667-fact-consistency-part-limit-");
  const story = factStory(20, 1);
  story.nodes[0]!.text = "x".repeat(MAX_FACT_CONSISTENCY_PART_CHARS + 1);
  await seedFactStory(fixture, story);
  const service = factConsistencyService(fixture, modelSettings(model.baseUrl));
  const input = {
    storyId: STORY_ID,
    focusedPartId: "root",
    scope: "story-line" as const
  };

  const plan = await service.plan(input);
  assert.equal(plan.partCount, 1);
  assert.equal(plan.requestCount, 0);
  const result = await service.check(
    { ...input, planToken: plan.planToken },
    new AbortController().signal
  );
  assert.equal(model.requests.length, 0);
  assert.match(result.run.parts[0]!.uncheckedReason ?? "", /size limit/u);
});

providerTest("Fact consistency hydrates an off-active selected take before prompting", async (t) => {
  const model = await fakeModel(t, (body, response) => {
    const prompt = requestPrompt(body);
    assert.match(prompt, /The off-active branch is the selected prose\./u);
    stream(response, [`NONE\n${completionMarker(prompt)}`]);
  });
  const fixture = await setup(t, "1667-fact-consistency-off-active-provider-");
  await seedFactStory(fixture, offActiveFactStory());
  const service = factConsistencyService(fixture, modelSettings(model.baseUrl));
  const input = {
    storyId: STORY_ID,
    focusedPartId: "off-active",
    scope: "story-line" as const
  };
  const plan = await service.plan(input);

  const result = await service.check(
    { ...input, planToken: plan.planToken },
    new AbortController().signal
  );

  assert.equal(model.requests.length, 1);
  assert.deepEqual(result.run.parts.map((part) => part.partId), ["off-active"]);
  assert.equal(result.run.parts[0]!.uncheckedReason, undefined);
});

providerTest("a missing completion marker leaves the part unchecked", async (t) => {
  const model = await fakeModel(t, (_body, response) => {
    stream(response, [
      "FACT: 1\nQUOTE: Mira\nSTATEMENT: The Fact and prose differ."
    ]);
  });
  const fixture = await setup(t, "1667-fact-consistency-marker-");
  await seedFactStory(fixture, factStory(20, 1));
  const service = factConsistencyService(fixture, modelSettings(model.baseUrl));
  const input = {
    storyId: STORY_ID,
    focusedPartId: "root",
    scope: "story-line" as const
  };
  const plan = await service.plan(input);

  const result = await service.check(
    { ...input, planToken: plan.planToken },
    new AbortController().signal
  );

  assert.equal(result.run.parts.length, 1);
  assert.deepEqual(result.run.parts[0]!.findings, []);
  assert.match(result.run.parts[0]!.uncheckedReason ?? "", /stopped before/u);
  assert.equal(result.payload.hasFactConsistencyRun, true);
});

providerTest("all Fact consistency provider failures fail without committing a run", async (t) => {
  const model = await fakeModel(t, (_body, response) => {
    response.writeHead(503).end("provider unavailable");
  });
  const fixture = await setup(t, "1667-fact-consistency-provider-errors-");
  await seedFactStory(fixture, factStory(20, 1, 2));
  const service = factConsistencyService(fixture, modelSettings(model.baseUrl));
  const input = {
    storyId: STORY_ID,
    focusedPartId: "root",
    scope: "story-line" as const
  };
  const plan = await service.plan(input);

  await assert.rejects(
    service.check(
      { ...input, planToken: plan.planToken },
      new AbortController().signal
    ),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.match(error.message, /model server returned|provider/u);
      return true;
    }
  );
  assert.equal(model.requests.length, 2);
  assert.equal(await service.getRun(STORY_ID), null);
});

providerTest("mixed Fact consistency provider results commit successful parts", async (t) => {
  let requestCount = 0;
  const model = await fakeModel(t, (body, response) => {
    requestCount += 1;
    if (requestCount === 1) {
      stream(response, [`NONE\n${completionMarker(requestPrompt(body))}`]);
      return;
    }
    response.writeHead(503).end("provider unavailable");
  });
  const fixture = await setup(t, "1667-fact-consistency-mixed-provider-results-");
  await seedFactStory(fixture, factStory(20, 1, 2));
  const service = factConsistencyService(fixture, modelSettings(model.baseUrl));
  const input = {
    storyId: STORY_ID,
    focusedPartId: "root",
    scope: "story-line" as const
  };
  const plan = await service.plan(input);

  const result = await service.check(
    { ...input, planToken: plan.planToken },
    new AbortController().signal
  );

  assert.equal(model.requests.length, 2);
  assert.equal(result.run.parts.length, 2);
  assert.equal(result.run.parts.filter((part) => part.uncheckedReason !== undefined).length, 1);
  assert.equal(result.payload.hasFactConsistencyRun, true);
});

providerTest("concurrent parts await one durable provider-start publication", async (t) => {
  const model = await fakeModel(t, (body, response) => {
    stream(response, [`NONE\n${completionMarker(requestPrompt(body))}`]);
  });
  const fixture = await setup(t, "1667-fact-consistency-start-");
  await seedFactStory(fixture, factStory(20, 1, 2));
  const service = factConsistencyService(fixture, modelSettings(model.baseUrl));
  const input = {
    storyId: STORY_ID,
    focusedPartId: "root",
    scope: "story-line" as const
  };
  const plan = await service.plan(input);
  let releaseStart!: () => void;
  const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
  let reportStart!: () => void;
  const startEntered = new Promise<void>((resolve) => { reportStart = resolve; });

  const running = service.check({ ...input, planToken: plan.planToken }, new AbortController().signal, {
    providerStarted: async () => {
      reportStart();
      await startGate;
    }
  });
  await startEntered;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(model.requests.length, 0);

  releaseStart();
  const result = await running;
  assert.equal(model.requests.length, 2);
  assert.equal(result.run.parts.length, 2);
});

providerTest("a different provider operation is busy while Fact consistency runs", async (t) => {
  let releaseProvider!: () => void;
  const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
  let reportRequest!: () => void;
  const requestSeen = new Promise<void>((resolve) => { reportRequest = resolve; });
  const model = await fakeModel(t, async (body, response) => {
    reportRequest();
    await providerGate;
    stream(response, [`NONE\n${completionMarker(requestPrompt(body))}`]);
  });
  t.after(() => releaseProvider());

  const fixture = await setup(t, "1667-fact-consistency-provider-busy-");
  await seedFactStory(fixture, factStory(20, 1));
  const service = factConsistencyService(fixture, modelSettings(model.baseUrl));
  const input = {
    storyId: STORY_ID,
    focusedPartId: "root",
    scope: "story-line" as const
  };
  const plan = await service.plan(input);
  const check = service.check({ ...input, planToken: plan.planToken }, new AbortController().signal);
  await requestSeen;

  await assert.rejects(
    service.check({ ...input, planToken: plan.planToken }, new AbortController().signal),
    (error: unknown) => {
      assert.ok(error instanceof ServiceError);
      assert.equal(error.status, 409);
      assert.equal(error.code, "conflict");
      assert.match(error.message, /plan is stale/u);
      return true;
    }
  );
  assert.equal(model.requests.length, 1);

  const version = (await fixture.stories.loadVersioned(STORY_ID)).aggregateVersion!;
  const competing = fixture.mutations.runProviderOperation(
    requestFor(OTHER_MUTATION_ID, OTHER_FINGERPRINT, version),
    "continueStory",
    providerOperation(
      async () => { throw new Error("competing provider work must not run"); },
      storyFixture
    )
  );
  await assert.rejects(competing, (error: unknown) => {
    assert.ok(error instanceof ServiceError);
    assert.equal(error.status, 409);
    assert.equal(error.code, "resource_busy");
    assert.match(error.message, /Fact consistency is running/u);
    return true;
  });

  const unresolved = await fixture.stories.withAggregateSession(
    STORY_ID,
    async (session) => session.snapshot.manifest.unresolvedProvider
  );
  assert.ok(unresolved);
  const checkReceipt = await fixture.ledger.loadStoryReceipt(
    `story:${STORY_ID}`,
    unresolved.mutationId
  );
  assert.equal(checkReceipt.started?.method, "checkFactConsistency");
  const competingReceipt = await fixture.ledger.loadStoryReceipt(
    `story:${STORY_ID}`,
    OTHER_MUTATION_ID
  );
  assert.equal(competingReceipt.started, null);
  assert.equal(competingReceipt.prepared, null);
  assert.equal(competingReceipt.completed, null);
  assert.equal(competingReceipt.acknowledged, null);

  releaseProvider();
  const result = await check;
  assert.equal(result.run.format, "1667-fact-consistency-run");
  assert.equal(
    (await fixture.stories.withAggregateSession(
      STORY_ID,
      async (session) => session.snapshot.manifest.unresolvedProvider
    )),
    null
  );
  assert.deepEqual(await service.getRun(STORY_ID), result.run);
});

providerTest("a different provider operation is busy at Fact consistency publish-start", async (t) => {
  let releaseProvider!: () => void;
  const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
  let reportRequest!: () => void;
  const requestSeen = new Promise<void>((resolve) => { reportRequest = resolve; });
  const model = await fakeModel(t, async (body, response) => {
    reportRequest();
    await providerGate;
    stream(response, [`NONE\n${completionMarker(requestPrompt(body))}`]);
  });
  t.after(() => releaseProvider());

  const fixture = await setup(t, "1667-fact-consistency-publish-busy-");
  await seedFactStory(fixture, factStory(20, 1));
  const service = factConsistencyService(fixture, modelSettings(model.baseUrl));
  const version = (await fixture.stories.loadVersioned(STORY_ID)).aggregateVersion!;
  let reportAdmission!: () => void;
  const competitorAdmitted = new Promise<void>((resolve) => { reportAdmission = resolve; });
  let releaseCompetitor!: () => void;
  const competitorGate = new Promise<void>((resolve) => { releaseCompetitor = resolve; });
  t.after(() => releaseCompetitor());
  const competing = fixture.mutations.runProviderOperation(
    requestFor(OTHER_MUTATION_ID, OTHER_FINGERPRINT, version),
    "continueStory",
    providerOperation(
      async (_stories, providerStarted) => {
        reportAdmission();
        await competitorGate;
        await providerStarted();
        throw new Error("competing provider work must not pass publish-start");
      },
      storyFixture
    )
  );
  await competitorAdmitted;

  const input = {
    storyId: STORY_ID,
    focusedPartId: "root",
    scope: "story-line" as const
  };
  const plan = await service.plan(input);
  const check = service.check({ ...input, planToken: plan.planToken }, new AbortController().signal);
  await requestSeen;
  releaseCompetitor();
  await assert.rejects(competing, (error: unknown) => {
    assert.ok(error instanceof ServiceError);
    assert.equal(error.status, 409);
    assert.equal(error.code, "resource_busy");
    assert.match(error.message, /Fact consistency is running/u);
    return true;
  });

  const unresolved = await fixture.stories.withAggregateSession(
    STORY_ID,
    async (session) => session.snapshot.manifest.unresolvedProvider
  );
  assert.ok(unresolved);
  const competingReceipt = await fixture.ledger.loadStoryReceipt(
    `story:${STORY_ID}`,
    OTHER_MUTATION_ID
  );
  assert.equal(competingReceipt.started, null);
  assert.equal(competingReceipt.prepared, null);
  assert.equal(competingReceipt.completed, null);
  assert.equal(competingReceipt.acknowledged, null);

  releaseProvider();
  const result = await check;
  assert.equal(result.run.format, "1667-fact-consistency-run");
  assert.equal(
    (await fixture.stories.withAggregateSession(
      STORY_ID,
      async (session) => session.snapshot.manifest.unresolvedProvider
    )),
    null
  );
  assert.deepEqual(await service.getRun(STORY_ID), result.run);
});

function factConsistencyService(
  fixture: Awaited<ReturnType<typeof setup>>,
  settings: GenerationSettings
): StoryServiceFactConsistency {
  const settingsStore = {
    loadGeneration: async () => ({
      settings,
      promptCache: LEGACY_PROMPT_CACHE_CONTEXT,
      imageInputCapability: null,
      writing: null
    }),
    assertProviderRequestSupported: () => {}
  } as unknown as SettingsStore;
  return new StoryServiceFactConsistency({
    stories: fixture.stories,
    settings: settingsStore,
    storyMutations: fixture.mutations,
    promptCache: new PromptCacheRuntime(),
    cancellable: async (signal, work) => await work(signal)
  });
}

async function seedFactStory(
  fixture: Awaited<ReturnType<typeof setup>>,
  story: Story
): Promise<void> {
  await fixture.mutations.runLocal(
    request(fixture.v5Hash),
    "createFact",
    (current) => {
      current.title = story.title;
      current.nodes = story.nodes;
      current.activeRootId = story.activeRootId;
      current.facts = story.facts;
    }
  );
}

function factStory(factTextChars: number, factCount: number, partCount = 1): Story {
  const now = "2026-01-01T00:00:00.000Z";
  const nodes = Array.from({ length: partCount }, (_, index) => ({
    id: index === 0 ? "root" : `part-${index}`,
    parentId: index === 0 ? null : index === 1 ? "root" : `part-${index - 1}`,
    instruction: "",
    text: "Mira crossed the square. The bell rang.",
    model: "human",
    createdAt: now,
    activeChildId: index + 1 >= partCount ? null : `part-${index + 1}`
  }));
  return {
    id: STORY_ID,
    title: "Fact check",
    createdAt: now,
    updatedAt: now,
    nodes,
    activeRootId: "root",
    tags: [],
    recentNodeIds: [],
    facts: Array.from({ length: factCount }, (_, index) => ({
      id: `fact-${index}`,
      name: `Fact ${index + 1}`,
      tag: null,
      states: [{
        id: `state-${index}`,
        text: "x".repeat(factTextChars),
        createdAt: now,
        updatedAt: now
      }],
      activation: "always" as const,
      keys: [],
      createdAt: now,
      updatedAt: now
    })),
    chapterBreaks: []
  };
}

function offActiveFactStory(): Story {
  const story = factStory(20, 1);
  const now = "2026-01-01T00:00:00.000Z";
  story.nodes = [
    {
      id: "root",
      parentId: null,
      instruction: "",
      text: "The root prose.",
      model: "human",
      createdAt: now,
      activeChildId: "active"
    },
    {
      id: "active",
      parentId: "root",
      instruction: "",
      text: "The active branch is not selected.",
      model: "human",
      createdAt: now,
      activeChildId: null
    },
    {
      id: "off-active",
      parentId: "root",
      instruction: "",
      text: "The off-active branch is the selected prose.",
      model: "human",
      createdAt: now,
      activeChildId: null
    }
  ];
  story.activeRootId = "root";
  return story;
}

function requestPrompt(body: Record<string, unknown>): string {
  assert.ok(Array.isArray(body.messages));
  return body.messages.map((message) => {
    assert.ok(message !== null && typeof message === "object");
    const content = (message as { content?: unknown }).content;
    assert.equal(typeof content, "string");
    return content;
  }).join("\n");
}

function completionMarker(prompt: string): string {
  const marker = prompt.match(/\[\[fact-consistency-complete-[a-f0-9]+\]\]/u)?.[0];
  assert.ok(marker);
  return marker;
}
