import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { platformPerformanceBudget } from "../../test/performance-budget.js";
import { ActionRuntime } from "../src/action-runtime.js";
import type { AppSource } from "../src/app.js";
import { normalizeUserConfig } from "../src/config.js";
import { DEMO_SETTINGS_VIEW } from "../src/demo.js";
import { generate } from "../src/generation-action.js";
import { RecoveryWarningFeed } from "../src/recovery-warning-feed.js";
import { ApiRecoveryRequiredError } from "../src/api-error.js";
import { createWorkerStoryApi, WorkerApiError } from "../src/worker-api.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";
import { initialState } from "../src/app.js";

/**
 * issue #326's fix keeps a deadline-interrupted generation's streamed prose
 * by committing it through `createNode` with its own `genId`
 * (`settleStoppedGeneration`, tui/src/generation-action.ts). That commit is a
 * mutating worker call, and `WorkerTransport.beginCall`
 * (tui/src/worker-transport.ts) refuses every mutating call while a recovery
 * warning is outstanding — including this one, since a clean worker stream
 * deadline is itself published as exactly such a warning
 * (worker-terminal.ts's uncertain-mutation branch archives the interrupted
 * continueStory and calls `recovery.warn`). Left unwrapped, the commit fails,
 * the stream stays preserved for display (`preserveStream: true`), and
 * recovery's own reconciliation (recovery-orchestration.ts's
 * `refreshAfterRecovery`) refuses to run while a stream is visible — a
 * deadlock, not a discard.
 *
 * `demoAppSource` (used by tui/test/generation-errors.test.ts) has no worker
 * transport and so cannot reach any of this; these two tests drive the real
 * embedded worker instead, the one place the fence actually lives.
 *
 * The deadline budget: real dry-run words arrive every 15ms
 * (server/providers.ts's streamDryRun) and the measured first delta lands
 * 24-31ms after the request starts (IPC to the worker, prompt assembly, the
 * provider's first yield, the 16ms delta batch window all sit in front of
 * it). 300ms keeps roughly 10x margin on that side while staying well short
 * of the full continuation (~1280ms, about 4x margin) — a 50ms budget left
 * under 2x margin on the fast side, and this repo already has documented
 * load flakes.
 */
const DEADLINE_MS = platformPerformanceBudget(300);

describe("deadline recovery through the real worker transport", () => {
  test("the recovery fence blocks an unwrapped commit and admits one routed through runRecoveryMutation", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "1667-worker-deadline-recovery-"));
    const backendRecovery = new RecoveryWarningFeed();
    const backend = await createWorkerStoryApi({
      dataDir,
      streamDeadlineMs: DEADLINE_MS,
      onRecoveryWarnings: (warnings) => backendRecovery.publish(warnings)
    });
    const api = backend.api;
    let unsubscribe: (() => void) | null = null;
    try {
      const created = await api.createStory("Deadline recovery");
      const seeded = await api.createNode(created.id, { parentId: null, text: "Root prose." });
      const storyId = seeded.id;
      const parentId = seeded.path[0]!.id;
      const genId = "deadline-recovery-take";

      const deltas: string[] = [];
      const rejected = await rejection(api.continueStory(
        storyId,
        "Continue.",
        genId,
        { parentId },
        (text) => deltas.push(text),
        new AbortController().signal
      ));

      // A clean deadline: worker-request-cancellation.ts's deadlineError
      // builds this with a plain ServiceError (no diagnosticCause), so it
      // carries no diagnosticRef — exactly what generation-action.ts's
      // isCleanWorkerMutationDeadline requires before it will let a stopped
      // generation commit, as opposed to a deadline masking some other
      // rejection.
      expect(rejected instanceof WorkerApiError).toBeTrue();
      const failure = rejected as unknown as WorkerApiError;
      expect(failure.status).toBe(408);
      expect(failure.code).toBe("mutation_outcome_unknown");
      expect(failure.diagnosticRef).toBe(null);
      const arrivedText = deltas.join("");
      expect(arrivedText.length > 0).toBeTrue();

      // The fence is real: the same commit generate()'s settleStoppedGeneration
      // would attempt, unwrapped, is refused while the deadline's recovery
      // warning is outstanding. This is the exact rejection that left the
      // prose stranded before this fix routed the commit through
      // RecoveryWarningFeed.runRecoveryMutation.
      const blocked = await rejection(api.createNode(storyId, {
        parentId,
        instruction: "Continue.",
        text: arrivedText,
        genId
      }));
      // Pre-send recovery fence: no request was posted; not an uncertain code.
      expect(blocked instanceof ApiRecoveryRequiredError).toBeTrue();
      expect(blocked instanceof WorkerApiError).toBeFalse();
      expect(blocked.message).toBe(
        "1667 is reloading saved state. Try again when the reload is complete."
      );

      // A recovery listener standing in for recovery-orchestration.ts's
      // refreshAfterRecovery: it must not resolve (adopt the warning) until
      // the interrupted generation has been committed or discarded — the
      // same gate that deadlocks against a preserved, uncommitted stream in
      // the real app.
      let releaseReconciliation!: () => void;
      const reconciliationGate = new Promise<void>((resolve) => {
        releaseReconciliation = resolve;
      });
      let reconciled = false;
      unsubscribe = backendRecovery.subscribe(async () => {
        await reconciliationGate;
        reconciled = true;
      }, () => {});

      // generation-action.ts's settleStoppedGeneration commits exactly this
      // way: the same createNode the fence just refused, now admitted
      // through runRecoveryMutation because it resolves the recovery
      // warning itself — the real generation's own text, under its own
      // genId, the same idempotent commit any other stopped generation uses.
      const committed = await backendRecovery.runRecoveryMutation(() =>
        api.createNode(storyId, {
          parentId,
          instruction: "Continue.",
          text: arrivedText,
          genId
        }));
      const landed = committed.path.at(-1)!;
      expect(landed.genId).toBe(genId);
      expect(landed.text).toBe(arrivedText.trim());
      // The commit landing does not, by itself, resolve the warning — only
      // reconciliation's own listener does that, the same as in the app.
      expect(reconciled).toBeFalse();

      // Only after the commit lands does the app clear its preserved stream
      // and let refreshAfterRecovery's reload proceed; release that gate now
      // to prove the warning resolves instead of staying blocked forever.
      releaseReconciliation();
      await reconciliationGate;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(reconciled).toBeTrue();

      // Recovery reconciled: an ordinary, unwrapped mutation is no longer
      // blocked by the deadline's warning.
      const after = await api.createNode(storyId, { parentId: landed.id, text: "Life goes on." });
      expect(after.path.at(-1)?.text).toBe("Life goes on.");
    } finally {
      unsubscribe?.();
      await backend.dispose();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("generate() commits a deadline-interrupted take through the real recovery fence", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "1667-generate-deadline-recovery-"));
    const backendRecovery = new RecoveryWarningFeed();
    const backend = await createWorkerStoryApi({
      dataDir,
      streamDeadlineMs: DEADLINE_MS,
      onRecoveryWarnings: (warnings) => backendRecovery.publish(warnings)
    });
    let unsubscribe: (() => void) | null = null;
    try {
      const api = backend.api;
      const created = await api.createStory("Deadline recovery via generate()");
      const seeded = await api.createNode(created.id, { parentId: null, text: "Root prose." });

      // continuationIntent (tui/src/continuation-intent.ts) only treats a
      // request as an append when the typed instruction is empty
      // (requestAppend requires requestedInstruction.trim().length === 0).
      // "Continue." is non-empty, so this is deterministically a new child
      // under the root, never growth in place — pin that branch rather than
      // accepting either.
      const instruction = "Continue.";
      const deltas: string[] = [];
      const realContinueStory = api.continueStory.bind(api);
      api.continueStory = (storyId, requestInstruction, genId, target, onDelta, signal) =>
        realContinueStory(storyId, requestInstruction, genId, target, (text) => {
          deltas.push(text);
          onDelta(text);
        }, signal);

      // A minimal real (non-demo) AppSource: the real worker API and a real
      // RecoveryWarningFeed, wired exactly as main.ts wires them, standing in
      // for the interactive TUI plumbing this test does not otherwise need.
      const source: AppSource = {
        payload: seeded,
        api,
        demo: false,
        stories: [],
        settingsView: DEMO_SETTINGS_VIEW,
        settings: DEMO_SETTINGS_VIEW.effective,
        storyFolder: "",
        exportDirectory: process.cwd(),
        connection: null,
        config: normalizeUserConfig({ updates: { mode: "notify" } }),
        readingPositions: {},
        backendRecovery
      };
      const state = initialState(source, false);
      const cache = createWrapCache<ProseStyle>();
      const actionRuntime = new ActionRuntime(state, () => undefined);
      const rootId = seeded.path[0]!.id;

      // Gated the same way as the fence test above: reconciliation must not
      // resolve until generate() has settled.
      let releaseReconciliation!: () => void;
      const reconciliationGate = new Promise<void>((resolve) => {
        releaseReconciliation = resolve;
      });
      let reconciled = false;
      unsubscribe = backendRecovery.subscribe(async () => {
        await reconciliationGate;
        reconciled = true;
      }, () => {});

      await actionRuntime.run("generating prose", (task) =>
        generate(state, source, cache, () => undefined, instruction, null, null, task));

      // The take landed despite the deadline: generate()'s
      // settleStoppedGeneration routed the commit through
      // RecoveryWarningFeed.runRecoveryMutation, so the real worker-transport
      // recovery fence (beginCall, worker-transport.ts) admitted it instead
      // of rejecting with "1667 is reloading saved state". A new child under
      // the root, carrying exactly the text that streamed before the
      // deadline fired.
      expect(state.payload.path.length).toBe(2);
      const landed = state.payload.path.at(-1)!;
      expect(landed.id).not.toBe(rootId);
      expect(landed.text).toBe(deltas.join("").trim());
      expect(state.toast).toContain("generation stopped");
      expect(state.toast).toContain("text kept");
      expect(state.stream).toBe(null);

      // The commit landing does not, by itself, resolve the warning.
      expect(reconciled).toBeFalse();
      releaseReconciliation();
      await reconciliationGate;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(reconciled).toBeTrue();

      // Recovery reconciled: an ordinary, unwrapped mutation is no longer
      // blocked by the deadline's warning.
      const after = await api.createNode(state.payload.id, { parentId: landed.id, text: "Life goes on." });
      expect(after.path.at(-1)?.text).toBe("Life goes on.");
    } finally {
      unsubscribe?.();
      await backend.dispose();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

async function rejection(promise: Promise<unknown>): Promise<Error & Record<string, unknown>> {
  try {
    await promise;
  } catch (error) {
    return error as Error & Record<string, unknown>;
  }
  throw new Error("Expected promise to reject");
}
