/**
 * Project selection and opening, shared by every command that runs against
 * an embedded Worker host: the TUI's own startup (`main.ts`) and `1667 web`
 * (`web-command.ts`). Both select a project the same way and unseal its
 * vault the same way; only what they do with the opened project differs.
 */
import {
  createProjectTier,
  resolveProject,
  type ResolvedProject
} from "../../server/project-discovery.js";
import { PROJECT_DIRECTORY_NAME } from "../../server/project-layout.js";
import {
  initializeProject,
  projectRequest,
  type ProjectSelection
} from "../../host/launcher-project.js";
import {
  canPromptForProject,
  confirmProjectCreation
} from "./project-prompt.js";
import {
  openSealedVault,
  revalidateSealedVault,
  revalidateUnsealedVault
} from "./vault-open.js";

export interface OpenedProject {
  readonly project: ResolvedProject;
  readonly vault: Awaited<ReturnType<typeof openSealedVault>>;
}

/**
 * Open the project this invocation names, asking once when none exists.
 * Returns null when the person declines, which is not an error.
 */
export async function openProject(
  selection: ProjectSelection
): Promise<OpenedProject | null> {
  const outcome = await resolveProject(projectRequest(selection));
  if (outcome.kind === "project") {
    // An explicitly named project — `--data` or `--global` — is explicit intent
    // to have one, so it is created. Discovery only ever finds existing ones.
    if (!outcome.project.exists) {
      await createProjectTier(outcome.project.directory);
      return { project: { ...outcome.project, exists: true }, vault: null };
    }
    return {
      project: outcome.project,
      vault: await openSealedVault(outcome.project.directory)
    };
  }
  const streams = { input: process.stdin, output: process.stdout };
  if (!canPromptForProject(streams)) {
    throw new Error(
      `no ${PROJECT_DIRECTORY_NAME} story project in ${outcome.cwd} or any parent. `
        + "Run '1667 init', or use --global."
    );
  }
  if (!await confirmProjectCreation(outcome.cwd, streams)) {
    process.stdout.write(
      "1667: no story project created. Run '1667 init' here, "
        + "or '1667 --global' for one shared library.\n"
    );
    return null;
  }
  return { project: await initializeProject(outcome.cwd), vault: null };
}

export interface EmbeddedVaultOptions {
  readonly vaultKey?: Buffer;
  readonly beforeVaultMigration: (lockedDataDirectory: string) => Promise<void>;
}

/**
 * The vault-unlock options an embedded Worker host needs for a project
 * `openProject` opened. Shared so every embedded command unseals a sealed
 * vault, and revalidates an unsealed one, the same way.
 */
export function embeddedVaultOptions(
  vault: OpenedProject["vault"]
): EmbeddedVaultOptions {
  if (vault === null) return { beforeVaultMigration: revalidateUnsealedVault };
  return {
    vaultKey: vault.key,
    beforeVaultMigration: async (lockedDataDirectory: string) => {
      await revalidateSealedVault(lockedDataDirectory, vault.keyslotBytes);
    }
  };
}
