import type { StoryApi } from "../../../client/api.js";
import type { CardImportPlan } from "../../../shared/card-import.js";
import { countNoun } from "../../../shared/fidelity.js";
import type { FactInput, StoryPayload } from "../../../shared/types.js";
import { retryWhenBusy } from "../app/busy-retry.js";
import { navigate } from "../app/router.js";
import type { AppState } from "../app/state.js";
import { failureToast, runStoryMutation } from "../app/story-mutation.js";
import type { Store } from "../app/store.js";
import { errorMessage, pushToast } from "../app/toasts.js";
import type { LibraryActions } from "../library/actions.js";
import type { StoryActions } from "../story/actions.js";
import { NOT_CONNECTED_TOAST, storyChangeRefusal } from "../story/story-policy.js";
import {
  ARCHIVE_ACCEPT,
  CARD_ACCEPT,
  STORY_FILE_ACCEPT,
  UNSUPPORTED_ARCHIVE,
  UNSUPPORTED_STORY_FILE,
  archiveRoute,
  baseName,
  pickFiles,
  storyFileKind,
  tooLargeMessage,
  type StoryFileKind
} from "./files.js";
import type { ImportReport, ImportsState } from "./state.js";

export interface ImportActionDependencies {
  readonly story: Pick<StoryActions, "adoptPayload">;
  readonly library: Pick<LibraryActions, "refresh">;
}

export interface ImportActions {
  /** The Library's "Import" button: choose story files. */
  pickStoryFiles(): void;
  /** A file drop, or the chosen files: each story file makes a new story; the last one opens. */
  importStories(files: readonly File[]): Promise<void>;
  /** The palette's "import character card": choose a card for the open story. */
  pickCard(): void;
  /** The palette's "import archive": choose an archive. */
  pickArchive(): void;
  closeReport(): void;
}

/** What a card or an archive import returns, in one shape. `plan` is set for a card. */
interface FactsImported {
  readonly facts: readonly FactInput[];
  readonly fidelity: readonly string[];
  readonly plan?: CardImportPlan;
}

export const IMPORT_RUNNING_TOAST = "An import is still running. Wait for it.";
export const OPEN_STORY_TOAST = "Open a story first.";

function factLabel(fact: FactInput): string {
  const named = fact.name?.trim() ?? "";
  const label = named.length > 0
    ? named
    : (fact.tag?.trim() ?? "").length > 0
    ? fact.tag!.trim()
    : fact.text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "Untitled fact";
  return label.length > 80 ? `${label.slice(0, 79)}…` : label;
}

function joinWords(values: readonly string[]): string {
  if (values.length === 0) return "no fields";
  if (values.length === 1) return values[0]!;
  return `${values.slice(0, -1).join(", ")} and ${values[values.length - 1]!}`;
}

/** The card's one-line account, as the TUI's `describeCardImport`. */
function cardSummary(plan: CardImportPlan): string {
  const skipped = plan.skipped.length === 0
    ? ""
    : ` · ${joinWords(plan.skipped)} ${plan.skipped.length === 1 ? "was" : "were"} empty`;
  return `${plan.facts.length} ${countNoun(plan.facts.length, "Fact")} for "${plan.name}" · ${joinWords(plan.used)}${skipped}`;
}

function archiveSummary(facts: readonly FactInput[]): string {
  const keyed = facts.filter((fact) => fact.activation === "keyed").length;
  return `${facts.length} ${countNoun(facts.length, "Fact")} imported · ${keyed} keyed · ${facts.length - keyed} always`;
}

export function createImportActions(store: Store<AppState>, deps: ImportActionDependencies): ImportActions {
  const write = (update: (imports: ImportsState) => ImportsState): void =>
    store.set((state) => {
      const imports = update(state.imports);
      return imports === state.imports ? state : { ...state, imports };
    });

  const setReport = (report: ImportReport): void => write((imports) => ({ ...imports, report }));

  function openStoryId(state: AppState): string | null {
    if (state.route.kind !== "story" || state.route.map === true || state.story.kind !== "loaded") return null;
    return state.story.payload.id === state.route.id ? state.route.id : null;
  }

  /** What every import checks first: a connection, no other import, a file in bounds. */
  function admit(file: File): StoryApi | null {
    const state = store.get();
    if (state.connection.kind !== "connected") {
      pushToast(store, NOT_CONNECTED_TOAST);
      return null;
    }
    if (state.imports.busy) {
      pushToast(store, IMPORT_RUNNING_TOAST);
      return null;
    }
    const large = tooLargeMessage(file.size);
    if (large !== null) {
      pushToast(store, large);
      return null;
    }
    return state.connection.api;
  }

  /** A story file makes a new story. Returns the new story's id, or `null` after a failure (already told). */
  async function createStory(api: StoryApi, file: File, kind: StoryFileKind): Promise<string | null> {
    try {
      const text = new TextDecoder("utf-8").decode(await file.arrayBuffer());
      let payload: StoryPayload;
      let fidelity: readonly string[] = [];
      if (kind === "markdown") {
        payload = await retryWhenBusy(() => api.importMarkdown(text, baseName(file.name)));
      } else {
        const send = kind === "sillytavern" ? api.importSillyTavern : kind === "novelai" ? api.importNovelAI : api.importScenario;
        const result = await retryWhenBusy(() => send.call(api, text));
        payload = result.payload;
        fidelity = result.fidelity;
      }
      if (fidelity.length > 0) {
        setReport({
          heading: `Imported ${payload.title}`,
          summary: `${payload.nodes.length} ${countNoun(payload.nodes.length, "part")} · ${payload.facts.length} ${countNoun(payload.facts.length, "Fact")}`,
          facts: [],
          leftOut: fidelity
        });
      }
      pushToast(store, `Imported "${payload.title}" · ${payload.nodes.length} ${countNoun(payload.nodes.length, "part")}`);
      return payload.id;
    } catch (error) {
      // A failed call can still have made a story: show the Library as it is.
      void deps.library.refresh();
      pushToast(store, `Importing ${file.name} failed: ${errorMessage(error)}`);
      return null;
    }
  }

  async function importStories(files: readonly File[]): Promise<void> {
    if (files.length === 0) return;
    // Nothing starts until every file is known to be a story file.
    const unsupported = files.find((file) => storyFileKind(file.name) === null);
    if (unsupported !== undefined) {
      pushToast(store, UNSUPPORTED_STORY_FILE);
      return;
    }
    const api = admit(files[0]!);
    if (api === null) return;
    write((imports) => ({ ...imports, busy: true }));
    let lastId: string | null = null;
    try {
      for (const file of files) {
        const large = tooLargeMessage(file.size);
        if (large !== null) {
          pushToast(store, large);
          break;
        }
        const id = await createStory(api, file, storyFileKind(file.name)!);
        if (id === null) break;
        lastId = id;
      }
      if (lastId !== null) {
        await deps.library.refresh();
        navigate({ kind: "story", id: lastId });
      }
    } finally {
      write((imports) => ({ ...imports, busy: false }));
    }
  }

  /** A card or a lorebook adds Facts to the open story, with the conflict and
   * lost-answer handling every story change shares. */
  async function importFacts(file: File, what: "character card" | "archive"): Promise<void> {
    const state = store.get();
    const storyId = openStoryId(state);
    if (storyId === null) {
      pushToast(store, OPEN_STORY_TOAST);
      return;
    }
    const api = admit(file);
    if (api === null) return;
    const refusal = storyChangeRefusal(state, storyId);
    if (refusal !== null) {
      pushToast(store, refusal);
      return;
    }
    const known = state.story.kind === "loaded" ? state.story.payload.facts.length : 0;
    write((imports) => ({ ...imports, busy: true }));
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const lostAnswer = (reloaded: StoryPayload): FactsImported | null =>
        reloaded.facts.length > known ? { facts: [], fidelity: [] } : null;
      const outcome = await runStoryMutation<FactsImported>(
        api,
        storyId,
        async () => {
          if (what === "character card") {
            const { payload, plan } = await api.importCard(storyId, bytes);
            return { payload, facts: plan.facts, fidelity: plan.fidelity, plan };
          }
          const { payload, importResult } = await api.importLorebook(storyId, bytes);
          return { payload, facts: importResult.facts, fidelity: importResult.fidelity };
        },
        lostAnswer
      );
      if (outcome.kind !== "saved") {
        if (outcome.kind !== "unresolved" && outcome.payload !== null) deps.story.adoptPayload(storyId, outcome.payload);
        pushToast(store, failureToast(outcome, `Importing the ${what}`));
        return;
      }
      const { facts, fidelity, plan } = outcome.value;
      const summary = outcome.reconciled
        ? "The answer was lost, but the story shows the new Facts."
        : plan !== undefined ? cardSummary(plan) : archiveSummary(facts);
      const message = outcome.reconciled ? "Imported. The report was lost." : plan !== undefined ? `Imported ${summary}` : summary;
      deps.story.adoptPayload(storyId, outcome.payload, { announcement: message });
      pushToast(store, message);
      setReport({
        heading: `${facts.length} ${countNoun(facts.length, "Fact")} added`,
        summary,
        facts: facts.map(factLabel),
        leftOut: fidelity
      });
    } catch (error) {
      pushToast(store, `Importing the ${what} failed: ${errorMessage(error)}`);
    } finally {
      write((imports) => ({ ...imports, busy: false }));
    }
  }

  /** An archive's route is by file name, as the TUI: Facts, or a new story. */
  async function importArchive(file: File): Promise<void> {
    const route = archiveRoute(file.name);
    if (route === null) {
      pushToast(store, UNSUPPORTED_ARCHIVE);
      return;
    }
    if (route === "facts") {
      await importFacts(file, "archive");
      return;
    }
    await importStories([file]);
  }

  return {
    pickStoryFiles: () => pickFiles({ accept: STORY_FILE_ACCEPT, multiple: true }, (files) => { void importStories(files); }),
    importStories,
    pickCard: () => pickFiles({ accept: CARD_ACCEPT, multiple: false }, (files) => { void importFacts(files[0]!, "character card"); }),
    pickArchive: () => pickFiles({ accept: ARCHIVE_ACCEPT, multiple: false }, (files) => { void importArchive(files[0]!); }),
    closeReport: () => write((imports) => (imports.report === null ? imports : { ...imports, report: null }))
  };
}
