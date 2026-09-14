import {
  exportProfile,
  importProfile
} from "../../host/launcher-profile.js";
import type { SettingsMutationResult } from "../../shared/settings-v2-types.js";
import { terminalLineText as plain } from "../../shared/terminal-text.js";
import { fidelityReport } from "../../shared/fidelity.js";
import { inlineValue, resolveExistingProject, separatedValue } from "./project-command.js";
import { openProjectBackend } from "./vault-project-backend.js";
import { settingsActivationFailureText } from "./settings-overlay-model.js";
import type { StoryApi } from "./api.js";

export interface ProfileCommandBackend {
  readonly api: Pick<StoryApi, "getSettings" | "saveSettings">;
  dispose(): Promise<void>;
}

export interface ProfileCommandDependencies {
  readonly createBackend?: (options: { readonly dataDir: string }) => Promise<ProfileCommandBackend>;
}

export interface ProfileCommand {
  readonly action: "import" | "export";
  readonly profile: string | null;
  readonly files: readonly string[];
  readonly data: string | null;
  readonly global: boolean;
  readonly force: boolean;
  readonly passphraseFile: string | null;
}

export function parseProfileCommand(argv: readonly string[]): ProfileCommand {
  const action = argv[0];
  if (action !== "import" && action !== "export") throw new Error("profile requires import or export");
  let profile: string | null = null;
  let data: string | null = null;
  let global = false;
  let force = false;
  let passphraseFile: string | null = null;
  const files: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--global") global = true;
    else if (argument === "--force") force = true;
    else if (argument.startsWith("--passphrase-file=")) {
      passphraseFile = inlineValue(argument, "--passphrase-file");
    }
    else if (argument.startsWith("--profile=")) profile = inlineValue(argument, "--profile");
    else if (argument.startsWith("--data=")) data = inlineValue(argument, "--data");
    else if (argument === "--profile" || argument === "--data" || argument === "--passphrase-file") {
      const value = separatedValue(argv, ++index, argument);
      if (argument === "--profile") profile = value;
      else if (argument === "--data") data = value;
      else passphraseFile = value;
    } else if (argument.startsWith("-")) throw new Error(`unknown profile option: ${plain(argument)}`);
    else files.push(argument);
  }
  if (global && data !== null) throw new Error("--global and --data select different projects");
  if (action === "import" && files.length === 0) throw new Error("profile import requires at least one file argument");
  if (action === "export" && files.length > 0) throw new Error("profile export does not accept a file argument");
  if (action === "import" && force) throw new Error("--force applies only to profile export");
  return { action, profile, files, data, global, force, passphraseFile };
}

export async function runProfileCommand(
  argv: readonly string[],
  output: Pick<NodeJS.WriteStream, "write"> = process.stdout,
  errorOutput: Pick<NodeJS.WriteStream, "write"> = process.stderr,
  dependencies: ProfileCommandDependencies = {}
): Promise<void> {
  const command = parseProfileCommand(argv);
  const project = await resolveExistingProject(command, command.action);
  const backend = dependencies.createBackend === undefined
    ? await openProjectBackend(project, command.passphraseFile)
    : await dependencies.createBackend({ dataDir: project.directory });
  let failed = false;
  try {
    if (command.action === "export") {
      const result = await exportProfile({
        api: backend.api,
        directory: project.root,
        profile: command.profile,
        force: command.force
      });
      output.write(`${plain(result.file)}\n`);
      writeFidelityReport(errorOutput, result.file, result.fidelity);
    } else {
      for (const file of command.files) {
        try {
          const result = await importProfile({
            api: backend.api,
            file,
            profile: command.profile
          });
          const activation = profileImportActivation(result.mutation);
          if (activation.kind === "failed") {
            failed = true;
            errorOutput.write(`${plain(file)}: ${activation.message}\n`);
            writeFidelityReport(errorOutput, file, result.fidelity);
            continue;
          }
          output.write(
            `${plain(file)}: imported "${plain(result.name)}" as ${result.profileId}`
              + ` (${result.importedCount} of ${result.candidateCount} parameters)`
              + `${activation.kind === "pending" ? " · activation pending" : ""}\n`
          );
          writeFidelityReport(errorOutput, file, result.fidelity);
        } catch (error) {
          failed = true;
          errorOutput.write(`${plain(file)}: ${plain(error instanceof Error ? error.message : String(error))}\n`);
        }
      }
    }
  } finally {
    await backend.dispose();
  }
  if (failed) process.exitCode = 1;
}

function writeFidelityReport(
  output: Pick<NodeJS.WriteStream, "write">,
  file: string,
  fidelity: readonly string[]
): void {
  output.write(`${plain(file)}: ${plain(fidelityReport(fidelity))}\n`);
}

function profileImportActivation(
  result: SettingsMutationResult
): { readonly kind: "active" | "pending" } | { readonly kind: "failed"; readonly message: string } {
  const outcome = result.activationOutcome;
  if (outcome !== null && outcome.result !== "committed") {
    return {
      kind: "failed",
      message: `saved, not active · ${settingsActivationFailureText(outcome.errorCode)}`
    };
  }
  return outcome === null && result.pendingSettingsRevision !== null
    ? { kind: "pending" }
    : { kind: "active" };
}
