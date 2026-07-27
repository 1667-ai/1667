import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import {
  formatSettingsDocumentV2,
  formatSettingsStateV2,
  parseSettingsDocumentV2,
  parseSettingsDocumentV2Text,
  parseSettingsStateV2,
  parseSettingsStateV2Text
} from "../server/settings-v2-codec.js";
import {
  applyEffectiveGenerationSettings,
  effectiveGenerationSettings
} from "../server/settings-v2-conversion.js";
import {
  INITIAL_SETTINGS_DOCUMENT_V2,
  INITIAL_SETTINGS_STATE_V2,
  INITIAL_SETTINGS_STATE_V2_TEXT
} from "../server/settings-v2-default.js";
import {
  recoverSettingsStateV2,
  reduceSettingsStateV2
} from "../server/settings-v2-reducer.js";
import {
  MAX_SETTINGS_DOCUMENT_BYTES,
  MAX_SETTINGS_STATE_BYTES
} from "../server/settings-v2-scalars.js";
import type {
  ModelConnectionV2,
  SettingsDocumentV2,
  SettingsStateV2
} from "../shared/settings-v2-types.js";

const MUTATION = `m1.1767225600000.${"e".repeat(32)}`;
const POINTER = { receiptKind: "user", mutationId: MUTATION, phase: "prepared" } as const;
const PREVIOUS_MUTATION = `m1.1767225599999.${"d".repeat(32)}`;
const PREVIOUS_POINTER = {
  receiptKind: "user",
  mutationId: PREVIOUS_MUTATION,
  phase: "prepared"
} as const;

// These budgets exist to catch algorithmic regressions in pure functions, so they
// measure CPU rather than wall clock. The Intel macOS runner is oversubscribed
// enough to report wall times near twice its own CPU time, while every other
// platform runs the two within a few percent; billing that scheduler contention
// against a pure-computation budget turns the whole matrix red at random.
function measured(run: () => void): { wallMs: number; cpuMs: number } {
  const startedCpu = process.cpuUsage();
  const startedAt = performance.now();
  run();
  const wallMs = performance.now() - startedAt;
  const usage = process.cpuUsage(startedCpu);
  return { wallMs, cpuMs: (usage.user + usage.system) / 1_000 };
}

function timing(wallMs: number, cpuMs: number): string {
  return `${wallMs.toFixed(1)}ms wall / ${cpuMs.toFixed(1)}ms CPU`;
}

test("settings v2 pure operations stay comfortably bounded", { concurrency: 1, timeout: 180_000 }, async (t) => {
  await t.test("10,000 canonical document parses", (context) => {
    const iterations = 10_000;
    const text = formatSettingsDocumentV2(INITIAL_SETTINGS_DOCUMENT_V2);
    let parsed = 0;
    const { wallMs, cpuMs } = measured(() => {
      for (let index = 0; index < iterations; index += 1) {
        parsed += parseSettingsDocumentV2Text(text).schemaVersion;
      }
    });
    context.diagnostic(`${iterations.toLocaleString()} document parses in ${timing(wallMs, cpuMs)}`);
    assert.equal(parsed, iterations * 2);
    assert.ok(cpuMs < 15_000, `document parsing took ${cpuMs.toFixed(1)}ms CPU`);
  });

  await t.test("5,000 canonical aggregate parses", (context) => {
    const iterations = 5_000;
    let generations = 0;
    const { wallMs, cpuMs } = measured(() => {
      for (let index = 0; index < iterations; index += 1) {
        generations += parseSettingsStateV2Text(INITIAL_SETTINGS_STATE_V2_TEXT).stateGeneration;
      }
    });
    context.diagnostic(`${iterations.toLocaleString()} aggregate parses in ${timing(wallMs, cpuMs)}`);
    assert.equal(generations, iterations);
    assert.ok(cpuMs < 15_000, `aggregate parsing took ${cpuMs.toFixed(1)}ms CPU`);
  });

  await t.test("500 staged whole-path preflights and bounded recoveries", (context) => {
    const iterations = 500;
    const candidate = applyEffectiveGenerationSettings(INITIAL_SETTINGS_DOCUMENT_V2, {
      ...effectiveGenerationSettings(INITIAL_SETTINGS_DOCUMENT_V2),
      provider: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      model: "performance-model",
      apiKeyEnv: "PERFORMANCE_MODEL_KEY"
    });
    let recovered = 0;
    const { wallMs, cpuMs } = measured(() => {
      for (let index = 0; index < iterations; index += 1) {
        const staged = reduceSettingsStateV2(INITIAL_SETTINGS_STATE_V2, {
          kind: "save-document",
          document: candidate,
          lastTransaction: POINTER
        });
        const validating = reduceSettingsStateV2(staged, {
          kind: "begin-validation",
          transactionId: MUTATION
        });
        recovered += recoverSettingsStateV2(validating).stateGeneration;
      }
    });
    context.diagnostic(
      `${iterations.toLocaleString()} preflight/recovery cycles in ${timing(wallMs, cpuMs)}`
    );
    assert.equal(recovered, iterations * 4);
    assert.ok(cpuMs < 15_000, `settings preflight/recovery took ${cpuMs.toFixed(1)}ms CPU`);
  });

  await t.test("near-limit document parse remains linear and bounded", (context) => {
    const document = largeDocument();
    const text = formatSettingsDocumentV2(document);
    const bytes = Buffer.byteLength(text, "utf8");
    assert.ok(bytes > 220 * 1024, `large fixture is only ${bytes} bytes`);
    assert.ok(bytes <= MAX_SETTINGS_DOCUMENT_BYTES);
    const iterations = 100;
    const { wallMs, cpuMs } = measured(() => {
      for (let index = 0; index < iterations; index += 1) parseSettingsDocumentV2Text(text);
    });
    context.diagnostic(
      `${iterations} parses of ${bytes.toLocaleString()} bytes in ${timing(wallMs, cpuMs)}`
    );
    assert.ok(cpuMs < 15_000, `near-limit parsing took ${cpuMs.toFixed(1)}ms CPU`);
  });

  await t.test("near-limit two-document preflight validates every activation successor", (context) => {
    const active = largeDocument();
    const candidate = largeDocument(true);
    const activeState = parseSettingsStateV2({
      ...INITIAL_SETTINGS_STATE_V2,
      stateGeneration: 2,
      settingsRevisionClock: 2,
      documents: { "2": active },
      activeRevision: 2,
      lastTransaction: PREVIOUS_POINTER
    });
    const staged = reduceSettingsStateV2(activeState, {
      kind: "save-document",
      document: candidate,
      lastTransaction: POINTER
    });
    const states = activationPathStates(staged);
    const documentBytes = [
      Buffer.byteLength(formatSettingsDocumentV2(active), "utf8"),
      Buffer.byteLength(formatSettingsDocumentV2(candidate), "utf8")
    ];
    const stagedBytes = Buffer.byteLength(formatSettingsStateV2(staged), "utf8");
    assert.ok(documentBytes.every((bytes) => bytes >= 240 * 1024));
    assert.ok(documentBytes.every((bytes) => bytes <= MAX_SETTINGS_DOCUMENT_BYTES));
    assert.ok(stagedBytes >= 480 * 1024, `staged fixture is only ${stagedBytes} bytes`);
    for (const state of states) {
      assert.ok(Buffer.byteLength(formatSettingsStateV2(state), "utf8") <= MAX_SETTINGS_STATE_BYTES);
    }

    const iterations = 3;
    let generations = 0;
    const { wallMs, cpuMs } = measured(() => {
      for (let index = 0; index < iterations; index += 1) {
        generations += reduceSettingsStateV2(activeState, {
          kind: "save-document",
          document: candidate,
          lastTransaction: POINTER
        }).stateGeneration;
      }
    });
    context.diagnostic(
      `${iterations} preflights of ${stagedBytes.toLocaleString()} bytes in ${timing(wallMs, cpuMs)}`
    );
    assert.equal(generations, iterations * 3);
    assert.ok(cpuMs < 10_000, `near-limit settings preflight took ${cpuMs.toFixed(1)}ms CPU`);
  });
});

function largeDocument(credentialed = false): SettingsDocumentV2 {
  const template: ModelConnectionV2 = {
    name: "Large fixture",
    preset: "custom",
    protocol: "openai-chat-completions",
    baseUrl: "https://example.com/v1",
    auth: { type: "none" },
    headers: [],
    timeouts: {
      responseHeaderMs: 120_000,
      firstTokenMs: 120_000,
      idleMs: 120_000,
      totalMs: 1_800_000
    }
  };
  const connections: Record<string, ModelConnectionV2> = {
    ...INITIAL_SETTINGS_DOCUMENT_V2.connections
  };
  for (let index = 0; index < 58; index += 1) {
    connections[`fixture:${index}`] = {
      ...template,
      auth: credentialed && index === 0
        ? { type: "bearer-env", env: "PERFORMANCE_MODEL_KEY" }
        : { type: "none" },
      baseUrl: `https://example.com/${"x".repeat(3_970)}${index}`
    };
  }
  return parseSettingsDocumentV2({
    ...INITIAL_SETTINGS_DOCUMENT_V2,
    connections
  });
}

function activationPathStates(staged: SettingsStateV2): SettingsStateV2[] {
  const validating = reduceSettingsStateV2(staged, {
    kind: "begin-validation",
    transactionId: MUTATION
  });
  const prepared = reduceSettingsStateV2(validating, { kind: "prepare" });
  const promoted = reduceSettingsStateV2(prepared, { kind: "promote" });
  const rollingFromPrepared = reduceSettingsStateV2(prepared, { kind: "begin-rollback" });
  const rollingFromPromoted = reduceSettingsStateV2(promoted, { kind: "begin-rollback" });
  const committed = reduceSettingsStateV2(promoted, { kind: "commit" });
  return [
    staged,
    validating,
    reduceSettingsStateV2(validating, {
      kind: "validation-failed",
      errorCode: "credential_unresolved"
    }),
    prepared,
    promoted,
    rollingFromPrepared,
    rollingFromPromoted,
    committed,
    reduceSettingsStateV2(rollingFromPrepared, {
      kind: "finish-rollback",
      errorCode: "readiness_failed"
    }),
    reduceSettingsStateV2(rollingFromPromoted, {
      kind: "finish-rollback",
      errorCode: "readiness_failed"
    }),
    reduceSettingsStateV2(committed, { kind: "finish-commit" })
  ];
}
