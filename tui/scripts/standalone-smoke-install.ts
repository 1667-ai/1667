import {
  access,
  chmod,
  copyFile,
  mkdir,
  readdir,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import {
  DATA_DIRECTORY_OWNER_MARKER,
  DATA_DIRECTORY_LOCK
} from "../../server/data-directory-layout.js";
import { PROJECT_DIRECTORY_NAME } from "../../server/project-layout.js";
import { runStandalone } from "./standalone-smoke-process.js";

/**
 * ADR007: relocating the executable must not lose the library. `--global` opens
 * the machine tier's own project, so two installs sharing one account see the
 * same stories, and a bare start outside a project writes nothing.
 */
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

  const refusedDefault = await runStandalone(
    firstExecutable,
    ["--render-once", "--size", "20x10"],
    installA,
    environment
  );
  assertAbsentProjectRefusal(refusedDefault, installA);
  await assertMissing(path.join(installA, PROJECT_DIRECTORY_NAME));

  const first = await runStandalone(
    firstExecutable,
    ["--global", "--render-once", "--size", "20x10"],
    installA,
    environment
  );
  if (first.exitCode !== 0) {
    throw new Error(
      `Installed global-project smoke failed (${first.exitCode}): `
        + first.stderr.trim()
    );
  }
  const globalProject = path.join(machineTierRoot(environment), "global");
  await Promise.all([
    access(path.join(globalProject, DATA_DIRECTORY_OWNER_MARKER)),
    access(path.join(globalProject, DATA_DIRECTORY_LOCK))
  ]);
  await assertMissing(path.join(installA, "data"));

  const second = await runStandalone(
    secondExecutable,
    ["--global", "--render-once", "--size", "20x10"],
    installB,
    environment
  );
  if (second.exitCode !== 0 || second.stdout !== first.stdout) {
    throw new Error(
      `Relocated upgrade did not preserve the global project (${second.exitCode}): `
        + second.stderr.trim()
    );
  }
  await assertMissing(path.join(installB, "data"));

  // An ordinary folder is admissible whether or not it already holds files:
  // the project tier lands beside them and touches nothing else.
  const empty = path.join(directory, "existing-empty");
  const nonempty = path.join(directory, "existing-nonempty");
  await Promise.all([mkdir(empty), mkdir(nonempty)]);
  await writeFile(path.join(nonempty, "draft.md"), "# draft\n");
  for (const [label, projectRoot] of [["empty", empty], ["nonempty", nonempty]]) {
    const opened = await runStandalone(
      firstExecutable,
      ["--data", projectRoot, "--render-once", "--size", "20x10"],
      installA,
      environment
    );
    if (opened.exitCode !== 0) {
      throw new Error(
        `Packaged 1667 refused an ordinary ${label} folder (${opened.exitCode}): `
          + opened.stderr.trim()
      );
    }
    await access(path.join(projectRoot, PROJECT_DIRECTORY_NAME));
  }
  if (JSON.stringify((await readdir(empty)).sort()) !== `["${PROJECT_DIRECTORY_NAME}"]`
    || JSON.stringify((await readdir(nonempty)).sort())
      !== `["${PROJECT_DIRECTORY_NAME}","draft.md"]`) {
    throw new Error("Opening a folder disturbed entries 1667 does not own");
  }
}

function machineTierRoot(environment: Record<string, string>): string {
  if (process.platform === "darwin") {
    return path.join(environment.HOME!, "Library", "Application Support", "1667", "State");
  }
  if (process.platform === "win32") {
    return path.win32.join(environment.LOCALAPPDATA!, "1667", "State");
  }
  return path.join(environment.XDG_STATE_HOME!, "1667");
}

async function assertMissing(target: string): Promise<void> {
  try {
    await access(target);
  } catch {
    return;
  }
  throw new Error(`Packaged smoke unexpectedly created ${target}`);
}

function assertAbsentProjectRefusal(
  result: { exitCode: number; stderr: string },
  cwd: string
): void {
  const required = [
    `no ${PROJECT_DIRECTORY_NAME} story project in ${cwd}`,
    "1667 init",
    "--global"
  ];
  if (result.exitCode !== 1
    || required.some((text) => !result.stderr.includes(text))
    || result.stderr.includes("\n    at ")) {
    throw new Error(
      `Packaged absent-project refusal was not actionable (${result.exitCode}): `
        + result.stderr.trim()
    );
  }
}
