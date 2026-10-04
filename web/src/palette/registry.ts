import type { AppActions } from "../app/actions.js";
import type { AppState } from "../app/state.js";
import type { Store } from "../app/store.js";

export type CommandSection = "suggested" | "story" | "take" | "view" | "system";

/** What a command reads and may call. `openLibrary` is the one piece of
 * screen state the palette needs: the sidebar's drawer belongs to the shell. */
export interface CommandContext {
  readonly store: Store<AppState>;
  readonly state: AppState;
  readonly actions: AppActions;
  readonly openLibrary: () => void;
}

/**
 * One palette command. A feature module registers its own commands with
 * `registerCommands`; the palette and keys help read only from this registry
 * and never name a feature. A command that is not `available` is not listed.
 * A command that is listed but cannot run right now refuses the way a key
 * does: `run` pushes a toast.
 */
export interface PaletteCommand {
  /** Stable id, the TUI's where it has one (`command-model.ts`). */
  readonly id: string;
  /** What the writer reads and types, lower case like the TUI. */
  readonly title: string;
  readonly description: string;
  readonly section: Exclude<CommandSection, "suggested">;
  /** The key that does the same, shown in the right column. */
  readonly shortcut?: string;
  readonly available?: (context: CommandContext) => boolean;
  readonly run: (context: CommandContext) => void;
}

const registry = new Map<string, PaletteCommand>();

/** Adds commands (a later command with the same id replaces the earlier one); returns the remover. */
export function registerCommands(commands: readonly PaletteCommand[]): () => void {
  for (const command of commands) registry.set(command.id, command);
  return () => {
    for (const command of commands) {
      if (registry.get(command.id) === command) registry.delete(command.id);
    }
  };
}

export function registeredCommands(): readonly PaletteCommand[] {
  return [...registry.values()];
}
