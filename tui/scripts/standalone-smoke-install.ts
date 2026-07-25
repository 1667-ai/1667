import {
  access,
  chmod,
  copyFile,
  mkdir,
  readdir,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { runStandalone } from "./standalone-smoke-process.js";

/** Prove install relocation preserves one account-scoped data target. */
export async function smokeInstalledDefaultData(
  executable: string,
  directory: string,
  environment: Record<string, string>
): Promise<void> {
  const executableName = process.platform === "win32" ? "1667.exe" : "1667";
  const installA = path.join(directory, "install-a");
  const installB = path.join(directory, "install-b");
  await Promise.all([mkdir(installA), mkdir(installB)]);
  const firstExecutable = path.join(installA, executableName);
  const secondExecutable = path.join(installB, executableName);
  await Promise.all([
    copyFile(executable, firstExecutable),
    copyFile(executable, secondExecutable)
  ]);
  if (process.platform !== "win32") {
    await Promise.all([
      chmod(firstExecutable, 0o755),
      chmod(secondExecutable, 0o755)
    ]);
  }
  const target = packagedDefaultDataTarget(environment);
  const refusedDefault = await runStandalone(
    firstExecutable,
    ["--render-once", "--size", "20x10"],
    installA,
    environment
  );
  assertUnownedRefusal(refusedDefault, "default absent data");
  await assertMissing(target);

  const first = await runStandalone(
    firstExecutable,
    [
      "--initialize-new",
      "--offline-exclusive",
      "--render-once",
      "--size",
      "20x10"
    ],
    installA,
    environment
  );
  if (first.exitCode !== 0) {
    throw new Error(
      `Installed default-data smoke failed (${first.exitCode}): `
        + first.stderr.trim()
    );
  }
  await Promise.all([
    access(path.join(target, ".1667-data-owner.json")),
    access(path.join(target, ".1667-data.lock"))
  ]);
  await assertMissing(path.join(installA, "data"));

  const second = await runStandalone(
    secondExecutable,
    ["--render-once", "--size", "20x10"],
    installB,
    environment
  );
  if (second.exitCode !== 0 || second.stdout !== first.stdout) {
    throw new Error(
      `Relocated upgrade did not preserve default data (${second.exitCode}): `
        + second.stderr.trim()
    );
  }
  await assertMissing(path.join(installB, "data"));

  const empty = path.join(directory, "existing-empty");
  const nonempty = path.join(directory, "existing-nonempty");
  await Promise.all([mkdir(empty, { mode: 0o700 }), mkdir(nonempty, { mode: 0o700 })]);
  await writeFile(path.join(nonempty, "legacy.json"), "{}\n");
  for (const [label, dataDir] of [["empty", empty], ["nonempty", nonempty]]) {
    const refused = await runStandalone(
      firstExecutable,
      [
        "--data",
        dataDir,
        "--initialize-new",
        "--offline-exclusive",
        "--render-once",
        "--size",
        "20x10"
      ],
      installA,
      environment
    );
    assertUnownedRefusal(refused, `${label} unowned data`);
  }
  if ((await readdir(empty)).length !== 0
    || JSON.stringify(await readdir(nonempty)) !== '["legacy.json"]') {
    throw new Error("Unowned data refusal mutated an existing directory");
  }
}

function packagedDefaultDataTarget(
  environment: Record<string, string>
): string {
  if (process.platform === "darwin") {
    return path.join(
      environment.HOME!,
      "Library",
      "Application Support",
      "1667",
      "Data",
      "default"
    );
  }
  if (process.platform === "win32") {
    return path.win32.join(
      environment.LOCALAPPDATA!,
      "1667",
      "Data",
      "default"
    );
  }
  return path.join(
    environment.XDG_DATA_HOME!,
    "1667",
    "default"
  );
}

async function assertMissing(target: string): Promise<void> {
  try {
    await access(target);
  } catch {
    return;
  }
  throw new Error(`Packaged smoke unexpectedly created ${target}`);
}

function assertUnownedRefusal(
  result: { exitCode: number; stderr: string },
  label: string
): void {
  const required = [
    "1667 --url <owning-server-url>",
    "--data <absolute-absent-path> --initialize-new --offline-exclusive",
    "serve --legacy-v1 --offline-exclusive --data <absolute-legacy-path>",
    "No in-place migration was attempted"
  ];
  if (result.exitCode !== 1
    || required.some((text) => !result.stderr.includes(text))) {
    throw new Error(
      `Packaged ${label} refusal was not actionable (${result.exitCode}): `
        + result.stderr.trim()
    );
  }
}
