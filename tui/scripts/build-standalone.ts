import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  createPackagedBuildIdentity,
  parseBuildIdentity,
  sameBuildIdentity,
  type BuildIdentity
} from "../../shared/build-identity.js";
import { releaseTargetForRuntime } from "../../shared/release-targets.js";
import {
  DATA_DIRECTORY_LOCK
} from "../../server/data-directory-layout.js";
import { PROJECT_DIRECTORY_NAME } from "../../server/project-layout.js";
import { smokeInstalledDefaultData } from "./standalone-smoke-install.js";
import { runStandalone } from "./standalone-smoke-process.js";
import { smokeSupervisedServe } from "./standalone-smoke-serve.js";

const tuiRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = path.dirname(tuiRoot);
const outputDirectory = path.join(tuiRoot, "dist");
const outputFile = path.join(outputDirectory, process.platform === "win32" ? "1667.exe" : "1667");
const execFileAsync = promisify(execFile);

await mkdir(outputDirectory, { recursive: true });
const buildIdentity = await deriveBuildIdentity();

const result = await Bun.build({
  entrypoints: [
    path.join(tuiRoot, "src", "standalone.ts"),
    path.join(tuiRoot, "..", "server", "worker.ts")
  ],
  compile: {
    outfile: outputFile,
    // A trusted executable must not run preload code or absorb backend routing
    // from the directory in which a user happens to launch it.
    autoloadBunfig: false,
    autoloadDotenv: false
  },
  define: {
    __AI_1667_BUILD_IDENTITY__: JSON.stringify(buildIdentity)
  },
  minify: true
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exitCode = 1;
} else {
  await smokeStandalone(outputFile, buildIdentity);
  console.log(outputFile);
}

async function deriveBuildIdentity(): Promise<BuildIdentity> {
  const supplied = process.env.AI_1667_BUILD_IDENTITY_JSON;
  if (supplied !== undefined) return parseBuildIdentity(JSON.parse(supplied));
  const [rootPackage, tuiPackage, rootLock, sourceCommit, sourceStatus] = await Promise.all([
    readJson(path.join(repositoryRoot, "package.json")),
    readJson(path.join(tuiRoot, "package.json")),
    readJson(path.join(repositoryRoot, "package-lock.json")),
    git("rev-parse", "--verify", "HEAD^{commit}"),
    git("status", "--porcelain=v1", "--untracked-files=normal")
  ]);
  const versions = [
    manifestVersion(rootPackage, "package.json"),
    manifestVersion(tuiPackage, "tui/package.json"),
    manifestVersion(rootLock, "package-lock.json"),
    lockRootVersion(rootLock)
  ];
  if (new Set(versions).size !== 1) {
    throw new Error(`Package versions disagree: ${versions.join(", ")}`);
  }
  return createPackagedBuildIdentity({
    productVersion: versions[0]!,
    sourceCommit,
    sourceDirty: sourceStatus.length > 0,
    buildTimestamp: new Date().toISOString(),
    artifactTarget: currentArtifactTarget()
  });
}

async function smokeStandalone(executable: string, expectedIdentity: BuildIdentity): Promise<void> {
  const directory = await mkdtemp(path.join(homedir(), ".1667-standalone-smoke-"));
  try {
    await writeFile(path.join(directory, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
    await writeFile(path.join(directory, "preload.ts"), 'throw new Error("hostile bunfig preload ran");\n');
    await writeFile(path.join(directory, ".env"), "AI_1667_URL=http://127.0.0.1:1\n");
    const environment = await smokeEnvironment(directory);
    const version = await runStandalone(executable, ["--version", "--json"], directory, environment);
    if (version.exitCode !== 0) {
      throw new Error(`Standalone identity smoke failed (${version.exitCode}): ${version.stderr.trim()}`);
    }
    const observedIdentity = parseBuildIdentity(JSON.parse(version.stdout));
    if (!sameBuildIdentity(observedIdentity, expectedIdentity)) {
      throw new Error("Standalone build identity does not match the build input");
    }
    const demo = await runStandalone(
      executable,
      ["--demo", "--render-once", "--size", "20x10"],
      directory,
      { ...environment, AI_1667_DATA: "relative-data-must-be-ignored" }
    );
    if (demo.exitCode !== 0) {
      throw new Error(
        `Standalone demo resolved irrelevant data configuration: ${demo.stderr.trim()}`
      );
    }
    for (const args of [
      ["--data", "", "--diagnostic"],
      ["--data", "--diagnostic"]
    ]) {
      const refusal = await runStandalone(
        executable,
        args,
        directory,
        environment
      );
      if (refusal.exitCode !== 2
        || refusal.stdout !== ""
        || !refusal.stderr.includes("--data requires a non-option value")
        || refusal.stderr.includes("\n    at ")) {
        throw new Error("Standalone accepted a missing separated CLI value");
      }
    }
    const embeddedData = path.join(directory, "embedded-data");
    const diagnostic = await runStandalone(
      executable,
      ["--data", embeddedData, "--diagnostic"],
      directory,
      environment
    );
    const diagnosticPayload = JSON.parse(diagnostic.stdout) as {
      project?: {
        source?: unknown;
        root?: unknown;
        directory?: unknown;
      };
    };
    if (diagnostic.exitCode !== 0
      || diagnostic.stderr !== ""
      || diagnosticPayload.project?.source !== "explicit"
      || diagnosticPayload.project.root !== embeddedData
      || diagnosticPayload.project.directory
        !== path.join(embeddedData, PROJECT_DIRECTORY_NAME)) {
      throw new Error(
        `Standalone diagnostic smoke failed (${diagnostic.exitCode}): `
          + diagnostic.stderr.trim()
      );
    }
    // ADR007 removed the packaged absolute-path requirement: a relative project
    // root resolves against the working directory on every build.
    const relativeDiagnostic = await runStandalone(
      executable,
      ["--data", "relative-diagnostic-data", "--diagnostic"],
      directory,
      environment
    );
    const relativePayload = JSON.parse(relativeDiagnostic.stdout) as {
      project?: { source?: unknown; root?: unknown };
    };
    if (relativeDiagnostic.exitCode !== 0
      || relativeDiagnostic.stderr !== ""
      || relativePayload.project?.source !== "explicit"
      || relativePayload.project.root
        !== path.join(directory, "relative-diagnostic-data")) {
      throw new Error(
        "Standalone diagnostic did not resolve a relative project root"
      );
    }
    // Discovery never writes, so reporting a project must not create one.
    await assertAbsent(path.join(embeddedData, PROJECT_DIRECTORY_NAME));
    const render = await runStandalone(
      executable,
      ["--data", embeddedData, "--render-once", "--size", "20x10"],
      directory,
      environment
    );
    if (process.platform === "win32") {
      // ADR007 relaxed the project tier, but the machine tier that holds
      // provider secrets still needs a DACL and reparse-safe adapter. Windows
      // therefore refuses the embedded backend in one actionable line, before
      // the backend starts, rather than opening a project it cannot key.
      if (render.exitCode !== 1
        || !/DACL/.test(render.stderr)
        || render.stderr.includes("\n    at ")) {
        throw new Error(
          "Windows embedded storage did not fail closed on its machine tier "
            + `(${render.exitCode}): ${render.stderr.trim()}`
        );
      }
      await assertAbsent(path.join(embeddedData, PROJECT_DIRECTORY_NAME));
      await smokePromptTokenizer(directory, environment);
      await smokeSupervisedServe(executable, directory, environment);
      return;
    }
    if (render.exitCode !== 0) {
      throw new Error(`Standalone render smoke failed (${render.exitCode}): ${render.stderr.trim()}`);
    }
    if (render.elapsedMs > 10_000) {
      throw new Error(
        `Standalone cold render exceeded 10s (${render.elapsedMs.toFixed(1)}ms)`
      );
    }
    await smokePromptTokenizer(directory, environment);
    await access(path.join(
      embeddedData,
      PROJECT_DIRECTORY_NAME,
      DATA_DIRECTORY_LOCK
    ));
    await smokeInstalledDefaultData(executable, directory, environment);
    await smokeSupervisedServe(executable, directory, environment);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function smokePromptTokenizer(
  directory: string,
  environment: Record<string, string>
): Promise<void> {
  const executable = path.join(
    directory,
    process.platform === "win32" ? "prompt-tokenizer-smoke.exe" : "prompt-tokenizer-smoke"
  );
  const result = await Bun.build({
    entrypoints: [path.join(tuiRoot, "scripts", "prompt-tokenizer-smoke.ts")],
    compile: {
      outfile: executable,
      autoloadBunfig: false,
      autoloadDotenv: false
    },
    minify: true
  });
  if (!result.success) {
    throw new Error(
      `Compiled prompt-tokenizer smoke failed to build: ${result.logs.join("\n")}`
    );
  }
  const smoke = await runStandalone(executable, [], directory, environment);
  if (smoke.exitCode !== 0) {
    throw new Error(
      `Compiled prompt-tokenizer smoke failed (${smoke.exitCode}): ${smoke.stderr.trim()}`
    );
  }
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8"));
}

function manifestVersion(value: unknown, label: string): string {
  if (value === null || typeof value !== "object" || typeof (value as { version?: unknown }).version !== "string") {
    throw new Error(`${label} has no package version`);
  }
  return (value as { version: string }).version;
}

function lockRootVersion(value: unknown): string {
  if (value === null || typeof value !== "object") throw new Error("package-lock.json is invalid");
  const packages = (value as { packages?: unknown }).packages;
  if (packages === null || typeof packages !== "object") throw new Error("package-lock.json has no package table");
  return manifestVersion((packages as Record<string, unknown>)[""], "package-lock.json root package");
}

async function git(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 1024 * 1024
  });
  return stdout.trim();
}

function currentArtifactTarget() {
  const target = `${process.platform}-${process.arch}`;
  const releaseTarget = releaseTargetForRuntime(process.platform, process.arch);
  if (releaseTarget === null) throw new Error(`Unsupported standalone target: ${target}`);
  return releaseTarget.artifactTarget;
}

async function smokeEnvironment(directory: string): Promise<Record<string, string>> {
  const home = path.join(directory, "home");
  const state = path.join(directory, "state");
  const data = path.join(directory, "platform-data");
  const config = path.join(directory, "config");
  await Promise.all([
    mkdir(home, { recursive: true, mode: 0o700 }),
    mkdir(state, { recursive: true, mode: 0o700 }),
    mkdir(data, { recursive: true, mode: 0o700 }),
    mkdir(config, { recursive: true, mode: 0o700 })
  ]);
  const environment: Record<string, string> = {
    TERM: process.env.TERM ?? "xterm-256color",
    HOME: home,
    XDG_STATE_HOME: state,
    XDG_DATA_HOME: data,
    XDG_CONFIG_HOME: config
  };
  for (const name of ["PATH", "LANG", "LC_ALL", "NO_COLOR", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  if (process.platform === "win32") {
    environment.LOCALAPPDATA = data;
    environment.TEMP = directory;
    environment.TMP = directory;
  } else {
    environment.TMPDIR = directory;
  }
  return environment;
}

async function assertAbsent(target: string): Promise<void> {
  try {
    await access(target);
  } catch {
    return;
  }
  throw new Error(`Standalone smoke unexpectedly created ${target}`);
}
