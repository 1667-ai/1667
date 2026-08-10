import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  decodeChildToSupervisorMessage,
  decodeSupervisorToChildMessage,
  isCredentialEnvironmentName,
  sameSupervisedOperationDescriptor,
  supervisedOperationKey
} from "../shared/supervised-serve-protocol.js";
import {
  decodeSupervisedSecrets,
  encodeSupervisedSecrets,
  SUPERVISED_SECRET_CHANNEL_MAX_BYTES
} from "../shared/supervised-secret-channel.js";
import {
  parseServeArguments,
  ServeSupervisor,
  sanitizedSupervisorChildEnvironment
} from "../tui/src/serve-supervisor.js";
import {
  assertSupervisedMachineTierOutsideProject,
  resolveSupervisedProject,
  recoverDescriptors,
  runSupervisedServeChild
} from "../server/supervised-serve-child.js";
import { DataDirectoryLock } from "../server/data-directory-lock.js";
import { publishDataDirectoryOwnerMarker } from "../server/data-directory-format.js";
import { PlatformStateRootError } from "../server/platform-state-root.js";
import { toPublicServiceError } from "../server/service-error-policy.js";
import { localStartupFailure } from "../server/local-startup-failure.js";
import { StoragePathNotDirectoryError } from "../server/story-lifecycle.js";
import {
  diagnosticMachineTierFailure
} from "../server/diagnostic-machine-tier.js";
import {
  MACHINE_TIER_OVERRIDE_VARIABLE
} from "../shared/machine-tier-environment.js";
import {
  linuxMountPathIsInsideDirectory
} from "../server/machine-tier-boundary.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("serve supervisor import closure excludes application and provider modules", async () => {
  const source = await readFile(
    path.join(ROOT, "tui", "src", "serve-supervisor.ts"),
    "utf8"
  );
  for (const forbidden of [
    "http-listener",
    "story-service",
    "settings",
    "providers",
    "storage",
    "data-directory"
  ]) {
    assert.doesNotMatch(source, new RegExp(`from [\"'][^\"']*${forbidden}`));
  }
});

test("supervised child environment keeps state root but excludes secrets", () => {
  const environment = sanitizedSupervisorChildEnvironment({
    PATH: "/bin",
    HOME: "/home/reader",
    [MACHINE_TIER_OVERRIDE_VARIABLE]: "/tmp/1667-state",
    OPENAI_API_KEY: "secret",
    BUN_OPTIONS: "--preload hostile.ts",
    NODE_OPTIONS: "--require hostile.js",
    AI_1667_URL: "http://127.0.0.1:1"
  });
  assert.deepEqual(environment, {
    PATH: "/bin",
    HOME: "/home/reader",
    [MACHINE_TIER_OVERRIDE_VARIABLE]: "/tmp/1667-state"
  });
});

test("supervised serve keeps machine state outside the project", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-supervised-boundary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, "book");
  await mkdir(project);
  const selected = await resolveSupervisedProject(["--data", project]);

  await assert.rejects(
    assertSupervisedMachineTierOutsideProject(
      selected,
      path.join(project, "state")
    ),
    /machine tier outside the project/
  );
  await assert.doesNotReject(
    assertSupervisedMachineTierOutsideProject(
      selected,
      path.join(root, "state")
    )
  );

  const real = path.join(root, "real");
  const alias = path.join(root, "alias");
  await mkdir(real);
  await symlink(real, alias, "dir");
  const future = await resolveSupervisedProject([
    "--data",
    path.join(alias, "future-project")
  ]);
  await assert.rejects(
    assertSupervisedMachineTierOutsideProject(
      future,
      path.join(real, "future-project", "state")
    ),
    /machine tier outside the project/
  );
});

test("supervised serve rechecks the sealed-vault fence through its retained authority", {
  skip: process.platform !== "linux"
}, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-supervised-vault-race-"));
  const machineDir = await mkdtemp(path.join(tmpdir(), "1667-supervised-machine-"));
  t.after(async () => await Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(machineDir, { recursive: true, force: true })
  ]));
  const dataDirectory = path.join(root, ".1667");
  const initializer = new DataDirectoryLock(dataDirectory);
  await initializer.acquire();
  await initializer.release();

  const previousMachineDirectory = process.env[MACHINE_TIER_OVERRIDE_VARIABLE];
  const processWithIpc = process as NodeJS.Process & {
    send?: (message: unknown) => boolean;
  };
  const previousSend = processWithIpc.send;
  const previousExitCode = process.exitCode;
  const messages: unknown[] = [];
  process.env[MACHINE_TIER_OVERRIDE_VARIABLE] = machineDir;
  processWithIpc.send = (message) => {
    messages.push(message);
    return true;
  };
  t.after(() => {
    if (previousMachineDirectory === undefined) {
      delete process.env[MACHINE_TIER_OVERRIDE_VARIABLE];
    } else {
      process.env[MACHINE_TIER_OVERRIDE_VARIABLE] = previousMachineDirectory;
    }
    if (previousSend === undefined) delete processWithIpc.send;
    else processWithIpc.send = previousSend;
    process.exitCode = previousExitCode;
  });

  let lockedAuthority: string | null = null;
  await runSupervisedServeChild([
    "--data", root,
    "--port", "0",
    "--secret-fd", "4"
  ], {
    beforeLockedVaultCheck: async (authorityPath) => {
      lockedAuthority = authorityPath;
      await publishDataDirectoryOwnerMarker(authorityPath, 5);
    }
  });

  assert.match(lockedAuthority ?? "", /^\/proc\/self\/fd\/\d+$/);
  assert.equal(process.exitCode, 1);
  assert.deepEqual(messages, [{
    type: "fatal",
    message: "serve cannot open a sealed vault; use the TUI or an offline command with --passphrase-file"
  }]);
});

test("machine-tier boundary rejects a bind-mounted project descendant", () => {
  const mountInfo = [
    "10 1 8:1 / / rw - ext4 /dev/root rw",
    "20 10 8:1 /project/private-state /outside/state rw - ext4 /dev/root rw",
    "30 10 8:2 / /other/state rw - ext4 /dev/other rw"
  ].join("\n");

  assert.equal(linuxMountPathIsInsideDirectory({
    directoryPath: "/project",
    candidatePath: "/outside/state",
    directoryMountId: "10",
    candidateMountId: "20",
    mountInfo
  }), true);
  assert.equal(linuxMountPathIsInsideDirectory({
    directoryPath: "/project",
    candidatePath: "/other/state",
    directoryMountId: "10",
    candidateMountId: "30",
    mountInfo
  }), false);
});

test("serve parser rejects empty separated and inline values", () => {
  for (const argv of [
    ["serve", "--data", ""],
    ["serve", "--data="],
    ["serve", "--port", ""],
    ["serve", "--port="]
  ]) {
    assert.throws(() => parseServeArguments(argv), /requires a value/);
  }
});

test("serve parser forwards explicit diagnostic printing", () => {
  assert.deepEqual(parseServeArguments([
    "serve",
    "--data",
    "/tmp/story",
    "--port",
    "0",
    "--print-logs"
  ]), {
    dataDir: "/tmp/story",
    port: 0,
    printLogs: true
  });
});

test("serve supervisor rejects a failed child exit during shutdown", async () => {
  const child = new EventEmitter() as EventEmitter & ChildProcess;
  Object.assign(child, {
    connected: true,
    stdio: [null, null, null, null, null],
    send(
      _message: unknown,
      callback: (error: Error | null) => void
    ) {
      callback(null);
      return true;
    },
    kill: () => true
  });
  const supervisor = new ServeSupervisor(
    { dataDir: null, port: 0, printLogs: false },
    (() => child) as typeof import("node:child_process").spawn
  );
  const previousHandlers = new Set(process.listeners("SIGTERM"));
  const running = supervisor.run();
  const handler = process.listeners("SIGTERM").find(
    (candidate) => !previousHandlers.has(candidate)
  );
  assert.notEqual(handler, undefined);
  handler!("SIGTERM");
  child.emit("exit", 1, null);

  await assert.rejects(running, /Supervised child exited with code 1/);
});

test("machine-tier startup preserves only actionable state-root failures", () => {
  const actionable = diagnosticMachineTierFailure(
    new PlatformStateRootError("Application state root is not private")
  );
  assert.equal(
    toPublicServiceError(actionable).message,
    "Application state root is not private"
  );
  assert.equal(
    toPublicServiceError(
      diagnosticMachineTierFailure(new Error("private resolution detail"))
    ).message,
    "Internal server error"
  );
});

test("local startup storage exposure is shared across transports", () => {
  const selected = new StoragePathNotDirectoryError(
    "/selected/project/stories"
  );

  assert.equal(
    toPublicServiceError(localStartupFailure(selected)).message,
    selected.message
  );
  assert.equal(
    toPublicServiceError(
      localStartupFailure(new Error("private runtime storage detail"))
    ).message,
    "Internal server error"
  );
});

test("supervised credential slots and operation keys are closed", () => {
  assert.equal(isCredentialEnvironmentName("OPENAI_API_KEY"), true);
  assert.equal(isCredentialEnvironmentName("lowercase"), true);
  assert.equal(isCredentialEnvironmentName("AI_1667_URL"), true);
  for (const name of [
    "BUN_OPTIONS",
    "NODE_OPTIONS",
    "HOME",
    "A".repeat(65)
  ]) {
    assert.equal(isCredentialEnvironmentName(name), false);
  }
  assert.equal(supervisedOperationKey({
    sessionId: "11".repeat(16),
    sequence: "42"
  }), `${"11".repeat(16)}:42`);
  assert.equal(sameSupervisedOperationDescriptor(
    {
      listenerInstanceId: "11".repeat(16),
      sessionId: "22".repeat(16),
      sequence: "1",
      scope: "story",
      operation: "listStories",
      mutationId: null,
      lifetime: "local",
      deadlineDelayMs: 30_000
    },
    {
      listenerInstanceId: "11".repeat(16),
      sessionId: "22".repeat(16),
      sequence: "1",
      scope: "story",
      operation: "listStories",
      mutationId: null,
      lifetime: "local",
      deadlineDelayMs: 30_000
    }
  ), true);
});

test("supervised lifecycle IPC rejects malformed and unbounded authority", () => {
  const descriptor = {
    listenerInstanceId: "11111111-1111-4111-8111-111111111111",
    sessionId: "22".repeat(16),
    sequence: "1",
    scope: "story",
    operation: "listStories",
    mutationId: null,
    lifetime: "local",
    deadlineDelayMs: 30_000
  } as const;
  assert.deepEqual(decodeChildToSupervisorMessage({
    type: "reserve",
    requestId: `${descriptor.sessionId}:1`,
    descriptor
  }), {
    type: "reserve",
    requestId: `${descriptor.sessionId}:1`,
    descriptor
  });
  assert.deepEqual(decodeChildToSupervisorMessage({
    type: "fatal",
    message: "Internal server error",
    diagnosticRef: "err_deadbeefdeadbeefdeadbeef"
  }), {
    type: "fatal",
    message: "Internal server error",
    diagnosticRef: "err_deadbeefdeadbeefdeadbeef"
  });
  assert.throws(
    () => decodeChildToSupervisorMessage({
      type: "fatal",
      message: "Internal server error",
      diagnosticRef: "invalid"
    }),
    /diagnostic reference/
  );
  assert.deepEqual(decodeSupervisorToChildMessage({
    type: "recover",
    descriptors: [descriptor]
  }), {
    type: "recover",
    descriptors: [descriptor]
  });
  assert.deepEqual(decodeChildToSupervisorMessage({
    type: "hard-deadline",
    sessionId: descriptor.sessionId,
    sequence: descriptor.sequence
  }), {
    type: "hard-deadline",
    sessionId: descriptor.sessionId,
    sequence: descriptor.sequence
  });
  assert.throws(
    () => decodeChildToSupervisorMessage({
      type: "terminal",
      descriptor: { ...descriptor, extra: true }
    }),
    /message fields are invalid/
  );
  assert.throws(
    () => decodeChildToSupervisorMessage({
      type: "terminal",
      descriptor: { ...descriptor, operation: "createStory" }
    }),
    /mutation identity/
  );
  assert.throws(
    () => decodeSupervisorToChildMessage({
      type: "recover",
      descriptors: [{ ...descriptor, deadlineDelayMs: 30_001 }]
    }),
    /deadline is invalid/
  );
});

test("supervised recovery reopens admission for replayable local receipts", async () => {
  const mutationId = "m1.1753356800000.22222222222222222222222222222222";
  const base = {
    listenerInstanceId: "11111111-1111-4111-8111-111111111111",
    sessionId: "22".repeat(16),
    sequence: "1",
    scope: "story",
    mutationId,
    lifetime: "local",
    deadlineDelayMs: 30_000
  } as const;
  const service = {
    inspectMutationReceipt: async () => ({
      state: "pending" as const,
      method: "renameStory" as const,
      fingerprint: "f".repeat(64)
    })
  };

  assert.deepEqual(await recoverDescriptors(
    service as never,
    [{ ...base, operation: "renameStory" }]
  ), [{
    sessionId: base.sessionId,
    sequence: base.sequence,
    state: "not-committed"
  }]);
  assert.deepEqual(await recoverDescriptors(
    service as never,
    [{ ...base, operation: "continueStory", lifetime: "generation" }]
  ), [{
    sessionId: base.sessionId,
    sequence: base.sequence,
    state: "generation-outcome-unknown"
  }]);
});

test("supervised secrets use one bounded canonical frame", () => {
  const bytes = encodeSupervisedSecrets({
    ANTHROPIC_API_KEY: "one",
    OPENAI_API_KEY: null
  });
  assert.deepEqual(decodeSupervisedSecrets(bytes), {
    ANTHROPIC_API_KEY: "one",
    OPENAI_API_KEY: null
  });
  const maximum = Object.fromEntries(
    Array.from({ length: 64 }, (_, index) => [
      `KEY_${String(index).padStart(2, "0")}`,
      null
    ])
  );
  assert.deepEqual(decodeSupervisedSecrets(encodeSupervisedSecrets(maximum)), maximum);
  assert.throws(
    () => encodeSupervisedSecrets({ ...maximum, KEY_64: null }),
    /invalid credential slots/
  );
  assert.throws(
    () => encodeSupervisedSecrets({ Z_KEY: "last", A_KEY: "first" }),
    /invalid credential slots/
  );
  assert.throws(
    () => decodeSupervisedSecrets(Buffer.alloc(
      SUPERVISED_SECRET_CHANNEL_MAX_BYTES + 1
    )),
    /invalid size/
  );
  assert.throws(
    () => decodeSupervisedSecrets(Buffer.from('{"OPENAI_API_KEY":"x"}\\nextra')),
    /canonical frame/
  );
});
