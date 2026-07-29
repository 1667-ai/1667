import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { preflightHttpApi } from "../../shared/http-compatibility.js";
import { readHttpAuthRecord } from "../../server/http-auth-record.js";
import { MACHINE_TIER_OVERRIDE_VARIABLE } from "../../server/machine-tier.js";

const [command, ...args] = process.argv.slice(2);

if (command === "capture" && args.length === 4) {
  await captureIdentity(...args as [string, string, string, string]);
} else if (command === "verify" && args.length === 3) {
  await verifyIdentities(...args as [string, string, string]);
} else {
  throw new Error(
    "Usage: standalone-btrfs-identity.ts "
      + "capture <executable> <project> <state> <output> "
      + "| verify <first> <snapshot> <clone>"
  );
}

async function captureIdentity(
  executableInput: string,
  projectInput: string,
  stateInput: string,
  outputInput: string
): Promise<void> {
  const executable = path.resolve(executableInput);
  const project = path.resolve(projectInput);
  const stateRoot = path.resolve(stateInput);
  const output = path.resolve(outputInput);
  const emptyPath = path.join(stateRoot, "empty-path");
  await mkdir(emptyPath, { recursive: true, mode: 0o700 });
  const environment = stringEnvironment({
    ...process.env,
    [MACHINE_TIER_OVERRIDE_VARIABLE]: stateRoot,
    PATH: emptyPath
  });
  const child = Bun.spawn(
    [executable, "serve", "--data", project, "--port", "0"],
    {
      cwd: path.dirname(project),
      env: environment,
      stdout: "pipe",
      stderr: "pipe"
    }
  );
  const stderr = new Response(child.stderr).text();
  try {
    const origin = await readServeOrigin(child.stdout);
    const { record } = await readHttpAuthRecord(origin, {
      stateRoot
    });
    const metadata = await preflightHttpApi(
      `${origin}/api/health`,
      undefined,
      fetch,
      {
        capability: record.capabilities.story,
        serverInstanceId: record.instanceId
      }
    );
    await writeFile(output, JSON.stringify({
      dataDirectoryClaimId: metadata.dataDirectoryClaimId,
      dataDirectoryId: metadata.dataDirectoryId
    }));
  } finally {
    child.kill("SIGTERM");
    const exitCode = await child.exited;
    const errorOutput = await stderr;
    if (exitCode !== 0) {
      throw new Error(
        `Packaged Btrfs serve failed (${exitCode}): ${errorOutput.trim()}`
      );
    }
  }
}

async function verifyIdentities(
  firstInput: string,
  snapshotInput: string,
  cloneInput: string
): Promise<void> {
  const [first, snapshot, clone] = await Promise.all(
    [firstInput, snapshotInput, cloneInput].map(async (file) =>
      decodeIdentity(await readFile(path.resolve(file), "utf8")))
  );
  if (first.dataDirectoryId !== snapshot.dataDirectoryId
    || first.dataDirectoryClaimId === snapshot.dataDirectoryClaimId) {
    throw new Error(
      "A Btrfs snapshot did not retain lineage with an independent claim"
    );
  }
  if (first.dataDirectoryId !== clone.dataDirectoryId
    || first.dataDirectoryClaimId === clone.dataDirectoryClaimId) {
    throw new Error("A Btrfs image clone inherited the source claim");
  }
}

function decodeIdentity(text: string): {
  readonly dataDirectoryClaimId: string;
  readonly dataDirectoryId: string;
} {
  const value: unknown = JSON.parse(text);
  if (value === null
    || typeof value !== "object"
    || !/^[0-9a-f]{64}$/.test(
      String((value as { dataDirectoryClaimId?: unknown })
        .dataDirectoryClaimId)
    )
    || !/^[0-9a-f]{64}$/.test(
      String((value as { dataDirectoryId?: unknown }).dataDirectoryId)
    )) {
    throw new Error("Packaged Btrfs identity output is invalid");
  }
  return value as {
    readonly dataDirectoryClaimId: string;
    readonly dataDirectoryId: string;
  };
}

async function readServeOrigin(
  stream: ReadableStream<Uint8Array>
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const timeout = setTimeout(() => {
    void reader.cancel("serve startup timeout");
  }, 30_000);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(buffered);
      if (match !== null) return match[1]!;
    }
    throw new Error(
      `Packaged Btrfs serve exited before readiness: ${buffered}`
    );
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
}

function stringEnvironment(
  environment: NodeJS.ProcessEnv
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined
    )
  );
}
