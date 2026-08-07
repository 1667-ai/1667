import { describe, expect, test } from "bun:test";
import { createFailureEnvelope } from "../../shared/failure-envelope.js";
import { rewriteStreamDigest } from "../../shared/rewrite-partial-contract.js";
import type { StoryPayload } from "../../shared/types.js";
import { ActionRuntime } from "../src/action-runtime.js";
import { ApiHttpError } from "../src/api-error.js";
import { initialState } from "../src/app.js";
import { demoAppSource } from "../src/demo.js";
import { generate } from "../src/generation-action.js";
import { createStoryViewModel, rowIndexForNode } from "../src/model.js";
import {
  openRewriteComposer,
  submitRewriteComposer
} from "../src/rewrite-action.js";
import { workerApiErrorFromFailure } from "../src/worker-error.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

/** The wire shape a clean provider idle timeout now carries (issue #345):
 *  the usual (502, "provider_failure") fold plus the one provenance stamp
 *  `provider-sse.ts` adds when its idle deadline is the whole failure. */
function providerIdleFailure(message: string) {
  return workerApiErrorFromFailure(createFailureEnvelope({
    code: "provider_failure",
    message,
    status: 502,
    timeout: "provider-idle"
  }));
}

/** The wire shape the HTTP client's own lease deadline produces
 *  (`operationDeadlineError`, tui/src/api.ts): (408, "operation_expired")
 *  stamped "operation-lease" only when the lease's typed TimeoutError was
 *  the abort reason. */
function leaseTimeoutFailure(message: string) {
  return new ApiHttpError(createFailureEnvelope({
    code: "operation_expired",
    message,
    status: 408,
    timeout: "operation-lease"
  }));
}

/** A provider rejection — including the exact-echo rejections — carries no
 *  provenance stamp and must never settle streamed prose. */
function providerRejectionFailure(message: string) {
  return workerApiErrorFromFailure(createFailureEnvelope({
    code: "provider_failure",
    message,
    status: 502
  }));
}

function continuationHarness(failure: () => Error) {
  const source = demoAppSource();
  const state = initialState(source, false);
  const cache = createWrapCache<ProseStyle>();
  const backend = new ActionRuntime(state, () => undefined);
  const entered = deferred<void>();
  const gate = deferred<void>();
  let genId = "";
  let saves = 0;
  const createNode = source.api.createNode;
  source.api.createNode = async (...args) => {
    saves += 1;
    return await createNode(...args);
  };
  state.focusIndex = rowIndexForNode(createStoryViewModel(state.payload), "p12");
  source.api.continueStory = async (
    _storyId,
    _instruction,
    requestGenId,
    _target,
    onDelta
  ) => {
    genId = requestGenId;
    onDelta("prose that arrived before the timeout");
    entered.resolve();
    await gate.promise;
    throw failure();
  };
  const pending = backend.run("generating prose", (task) =>
    generate(state, source, cache, () => undefined, "keep going", null, null, task));
  return {
    source,
    state,
    entered,
    gate,
    pending,
    genId: () => genId,
    saves: () => saves
  };
}

describe("timeout-class failures preserve streamed prose", () => {
  test("a provider idle timeout keeps text that already streamed", async () => {
    const run = continuationHarness(() =>
      providerIdleFailure("Model stream was idle beyond the configured deadline."));
    await run.entered.promise;
    run.gate.resolve();
    await run.pending;

    expect(run.saves()).toBe(1);
    const created = run.state.payload.path.find((node) => node.genId === run.genId());
    expect(created?.text).toBe("prose that arrived before the timeout");
    expect(run.state.toast).toBe(
      "Model stream was idle beyond the configured deadline. · generation stopped · text kept"
    );
  });

  test("a clean HTTP operation-lease timeout keeps text that already streamed", async () => {
    const run = continuationHarness(() =>
      leaseTimeoutFailure("Generation exceeded its operation deadline. Reload the story before retrying."));
    await run.entered.promise;
    run.gate.resolve();
    await run.pending;

    expect(run.saves()).toBe(1);
    const created = run.state.payload.path.find((node) => node.genId === run.genId());
    expect(created?.text).toBe("prose that arrived before the timeout");
  });

  test("a provider rejection without provenance commits nothing", async () => {
    const run = continuationHarness(() =>
      providerRejectionFailure("The model did not continue from the exact final characters; nothing was saved."));
    await run.entered.promise;
    run.gate.resolve();
    await run.pending;

    expect(run.saves()).toBe(0);
    expect(run.state.payload.path.some((node) => node.genId === run.genId())).toBeFalse();
    expect(run.state.toast).toBe(
      "The model did not continue from the exact final characters; nothing was saved."
    );
  });
});

function rewriteHarness(options: {
  failure: () => Error;
  settle: "commit" | "refuse" | null;
}) {
  const source = demoAppSource();
  const state = initialState(source, false);
  const cache = createWrapCache<ProseStyle>();
  const backend = new ActionRuntime(state, () => undefined);
  const node = state.payload.path.find((candidate) => candidate.id === "p12")!;
  const expected = "the brass compass";
  const start = node.text.indexOf(expected);
  const end = start + expected.length;
  const entered = deferred<void>();
  const gate = deferred<void>();
  let settleCalls = 0;
  let settleStreamedText: string | null = null;
  source.api.rewriteNode = async (_storyId, _nodeId, _body, onDelta) => {
    onDelta("a dented compass");
    entered.resolve();
    await gate.promise;
    throw options.failure();
  };
  source.api.commitPartialRewrite = async (_storyId, nodeId, streamedDigest) => {
    settleCalls += 1;
    settleStreamedText = streamedDigest;
    if (options.settle !== "commit") return null;
    const payload = structuredClone(state.payload) as StoryPayload;
    const target = payload.path.find((candidate) => candidate.id === nodeId)!;
    const replacement = "a dented compass";
    target.text = node.text.slice(0, start) + replacement + node.text.slice(end);
    target.rewrittenSpans = [{ start, end: start + replacement.length }];
    return { payload, nodeId };
  };
  const prompt = openRewriteComposer(state, { node, start, end, expected });
  const pending = submitRewriteComposer(
    state,
    source,
    { backend, cache, repaint: () => undefined },
    prompt,
    { kind: "rewrite", start, end, expected },
    ""
  );
  return {
    state,
    node,
    start,
    end,
    entered,
    gate,
    pending,
    settleCalls: () => settleCalls,
    settleStreamedText: () => settleStreamedText
  };
}

describe("timeout-class failures settle a partial rewrite", () => {
  test("a provider idle timeout asks the backend to commit the streamed partial", async () => {
    const run = rewriteHarness({
      failure: () => providerIdleFailure("Model stream was idle beyond the configured deadline."),
      settle: "commit"
    });
    await run.entered.promise;
    run.gate.resolve();
    await run.pending;

    expect(run.settleCalls()).toBe(1);
    expect(run.settleStreamedText()).toBe(
      rewriteStreamDigest("a dented compass")
    );
    const landed = run.state.payload.path.find((candidate) => candidate.id === run.node.id)!;
    expect(landed.text).toBe(
      run.node.text.slice(0, run.start) + "a dented compass" + run.node.text.slice(run.end)
    );
    expect(run.state.toast).toBe(
      "Model stream was idle beyond the configured deadline. · rewrite stopped · text kept"
    );
  });

  test("a refused settle never reports text kept", async () => {
    const run = rewriteHarness({
      failure: () => providerIdleFailure("Model stream was idle beyond the configured deadline."),
      settle: "refuse"
    });
    await run.entered.promise;
    run.gate.resolve();
    await run.pending;

    expect(run.settleCalls()).toBe(1);
    const landed = run.state.payload.path.find((candidate) => candidate.id === run.node.id)!;
    expect(landed.text).toBe(run.node.text);
    expect(run.state.toast).toBe("Model stream was idle beyond the configured deadline.");
  });

  test("a provider rejection without provenance never reaches the settle", async () => {
    const run = rewriteHarness({
      failure: () => providerRejectionFailure(
        "The model did not reconnect the replacement to the exact text before it; nothing was saved."
      ),
      settle: null
    });
    await run.entered.promise;
    run.gate.resolve();
    await run.pending;

    expect(run.settleCalls()).toBe(0);
    const landed = run.state.payload.path.find((candidate) => candidate.id === run.node.id)!;
    expect(landed.text).toBe(run.node.text);
    expect(run.state.toast).toBe(
      "The model did not reconnect the replacement to the exact text before it; nothing was saved."
    );
  });
});
