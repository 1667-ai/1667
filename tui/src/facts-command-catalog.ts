import type { CommandPaletteContext, PaletteCommand } from "./command-model.js";
import type { FactEditorSession } from "./state.js";

/** Fact entry points and Fact-editor actions. The command model owns grouping
 * and search; this catalog owns the Fact vocabulary and context gates. */
export const FACT_COMMAND_DEFINITIONS: readonly PaletteCommand[] = [
  {
    id: "check-chapter-against-facts", section: "story", name: "check chapter against Facts",
    description: "find contradictions in the focused chapter without changing prose",
    blockedByLiveStream: true,
    requires: (context) => context.hasStoryPart === true
      && context.hasFacts === true && context.factEditor !== true,
    searchTerms: ["check chapter", "fact consistency", "contradictions chapter"]
  },
  {
    id: "check-story-line-against-facts", section: "story", name: "check story line against Facts",
    description: "find contradictions in the selected story line without changing prose",
    blockedByLiveStream: true,
    requires: (context) => context.hasStoryPart === true
      && context.hasFacts === true && context.factEditor !== true,
    searchTerms: ["check story line", "fact consistency", "contradictions line"]
  },
  {
    id: "show-fact-findings", section: "story", name: "show Fact findings",
    description: "reopen the latest Fact consistency findings",
    requires: (context) => context.hasFactConsistencyRun === true && context.factEditor !== true,
    searchTerms: ["show fact findings", "fact findings", "fact consistency results"]
  },
  {
    id: "facts", section: "story", name: "facts overview", description: "open the Facts manager and inspect story memory",
    requires: (context) => context.factEditor !== true,
    searchTerms: ["facts", "fact manager", "manage facts", "fact overview"]
  },
  {
    id: "new-fact", section: "story", name: "new unscoped fact", description: "create a story-wide Fact",
    requires: (context) => context.factEditor !== true,
    searchTerms: ["new fact", "unscoped fact", "fact-new"]
  },
  {
    id: "new-fact-from-here", section: "story", name: "new Fact from here",
    description: "create a Fact scoped to the focused story part",
    requires: (context) => context.hasStoryPart === true && context.factEditor !== true,
    searchTerms: ["fact from here", "scoped fact"]
  },
  {
    id: "new-fact-from-selection", section: "story", name: "new Fact from selection",
    description: "create a Fact from highlighted story text",
    requires: (context) => context.hasStorySelection === true && context.factEditor !== true,
    searchTerms: ["fact from selection", "selection fact"]
  },
  {
    id: "edit-fact", section: "story", name: "edit selected Fact",
    description: "open a Fact in the editor, or choose one in Facts",
    requires: (context) => context.factEditor !== true,
    searchTerms: [
      "edit fact", "manage fact", "Fact name", "Fact tag", "Fact scope",
      "Fact activation", "Fact keys", "Fact priority", "per-Fact budget"
    ]
  },
  {
    id: "new-fact-state", section: "story", name: "new Fact State",
    description: "add a Fact State at the focused story part",
    requires: (context) => context.hasStoryPart === true && context.factEditor !== true,
    searchTerms: ["add fact state", "fact state", "state from here"]
  },
  {
    id: "end-fact-here", section: "story", name: "end Fact here",
    description: "add an End State at the focused story part",
    requires: (context) => context.hasStoryPart === true && context.factEditor !== true,
    searchTerms: ["end fact", "fact end state", "end state"]
  },
  {
    id: "facts-open-selected", section: "story", name: "open selected Fact",
    description: "open the selected Fact or its state dossier",
    requires: (context) => context.factsPanel === true && context.factsDossier !== true
      && context.factsFiltering !== true && context.factsSelected === true,
    searchTerms: ["open fact", "fact dossier", "selected fact"]
  },
  {
    id: "facts-filter", section: "story", name: "filter Facts",
    description: "search the Facts manager",
    requires: (context) => context.factsPanel === true && context.factsDossier !== true
      && context.factsFiltering !== true,
    searchTerms: ["filter facts", "search facts", "fact filter"]
  },
  {
    id: "facts-cycle-tag", section: "story", name: "cycle Fact tag",
    description: "move through the saved Fact tag filters",
    requires: (context) => context.factsPanel === true && context.factsDossier !== true
      && context.factsFiltering !== true,
    searchTerms: ["fact tag", "next fact tag", "tag filter"]
  },
  {
    id: "facts-clear-filter", section: "story", name: "clear Facts filter",
    description: "leave the active Facts search or tag filter",
    requires: (context) => context.factsPanel === true && context.factsDossier !== true
      && (context.factsFiltering === true || context.factsHasFilter === true),
    searchTerms: ["clear facts", "reset facts", "close fact filter"]
  },
  {
    id: "facts-cycle-scope", section: "story", name: "cycle Fact scope",
    description: "show Facts everywhere, on this line, elsewhere, or ended",
    requires: (context) => context.factsPanel === true && context.factsDossier !== true
      && context.factsFiltering !== true,
    searchTerms: ["fact scope", "scope filter", "everywhere this line"]
  },
  {
    id: "facts-delete", section: "story", name: "delete selected Fact", mutating: true,
    description: "arm the existing Fact delete confirmation",
    requires: (context) => context.factsPanel === true && context.factsDossier !== true
      && context.factsFiltering !== true && context.factsSelected === true,
    searchTerms: ["delete fact", "remove fact"]
  },
  {
    id: "facts-move-up", section: "story", name: "move Fact earlier", mutating: true,
    description: "move the selected Fact earlier in the Facts list",
    requires: (context) => context.factsPanel === true && context.factsDossier !== true
      && context.factsFiltering !== true && context.factsCanMoveUp === true,
    searchTerms: ["move fact up", "reorder fact", "fact earlier"]
  },
  {
    id: "facts-move-down", section: "story", name: "move Fact later", mutating: true,
    description: "move the selected Fact later in the Facts list",
    requires: (context) => context.factsPanel === true && context.factsDossier !== true
      && context.factsFiltering !== true && context.factsCanMoveDown === true,
    searchTerms: ["move fact down", "reorder fact", "fact later"]
  },
  {
    id: "facts-open-anchor", section: "story", name: "open Fact State Anchor",
    description: "jump from the Fact dossier to its selected story anchor",
    requires: (context) => context.factsPanel === true && context.factsDossier === true,
    searchTerms: ["open fact anchor", "dossier anchor", "state anchor"]
  },
  {
    id: "facts-edit-state", section: "story", name: "edit Fact State",
    description: "edit the selected state in the Fact editor",
    requires: (context) => context.factsPanel === true && context.factsDossier === true,
    searchTerms: ["edit state", "edit fact state", "dossier edit"]
  },
  {
    id: "facts-dossier-previous-state", section: "story", name: "previous dossier Fact State",
    description: "select the previous state in the Fact dossier",
    requires: (context) => context.factsPanel === true && context.factsDossier === true,
    searchTerms: ["previous dossier state", "previous fact state"]
  },
  {
    id: "facts-dossier-next-state", section: "story", name: "next dossier Fact State",
    description: "select the next state in the Fact dossier",
    requires: (context) => context.factsPanel === true && context.factsDossier === true,
    searchTerms: ["next dossier state", "next fact state"]
  },
  {
    id: "facts-toggle-diff", section: "story", name: "compare Fact States",
    description: "show or hide the selected Fact State diff",
    requires: (context) => context.factsPanel === true && context.factsDossier === true,
    searchTerms: ["Fact diff", "compare states", "state diff"]
  },
  {
    id: "fact-editor-toggle-view", section: "story", name: "toggle Fact editor view",
    description: "show or hide advanced Fact fields",
    requires: (context) => context.factEditor === true,
    searchTerms: ["fact editor basic advanced", "advanced Fact fields", "fact view"]
  },
  {
    id: "fact-editor-previous-state", section: "story", name: "previous Fact State",
    description: "select the previous Fact State",
    requires: (context) => context.factEditorStateful === true && context.factEditorHasState === true,
    searchTerms: ["previous state", "previous fact state", "fact state back"]
  },
  {
    id: "fact-editor-next-state", section: "story", name: "next Fact State",
    description: "select the next Fact State",
    requires: (context) => context.factEditorStateful === true && context.factEditorHasState === true,
    searchTerms: ["next state", "next fact state", "fact state forward"]
  },
  {
    id: "fact-editor-new-state", section: "story", name: "add Fact State",
    description: "start a new Fact State draft",
    requires: (context) => context.factEditorStateful === true && context.factEditorStateCreating !== true,
    searchTerms: ["new state", "add state", "fact editor state"]
  },
  {
    id: "fact-editor-open-anchor", section: "story", name: "open Fact State Anchor",
    description: "jump to the selected Fact State Anchor",
    requires: (context) => context.factEditorCanOpenAnchor === true,
    searchTerms: ["open anchor", "fact anchor", "state anchor"]
  },
  {
    id: "fact-editor-reanchor-state", section: "story", name: "re-anchor Fact State",
    description: "move the selected Fact State to the story cursor",
    requires: (context) => context.factEditorStateful === true
      && (context.factEditorHasState === true || context.factEditorStateCreating === true),
    searchTerms: ["reanchor state", "re-anchor", "move fact state"]
  },
  {
    id: "fact-editor-convert-state", section: "story", name: "convert Fact State",
    description: "toggle the selected state between text and End State",
    requires: (context) => context.factEditorStateful === true && context.factEditorHasState === true,
    searchTerms: ["convert state", "text state", "end state"]
  },
  {
    id: "fact-editor-delete-state", section: "story", name: "delete Fact State",
    description: "arm the existing Fact State delete confirmation",
    requires: (context) => context.factEditorCanDeleteState === true,
    searchTerms: ["delete state", "remove fact state"]
  },
  {
    id: "map-open-fact-lens", section: "view", name: "open Fact lens",
    description: "show Fact anchors in the tree map",
    requires: (context) => context.mapTree === true && context.mapFactLens !== true,
    searchTerms: ["fact lens", "map facts", "lens facts"]
  },
  {
    id: "map-cycle-fact-lens", section: "view", name: "next Fact in lens",
    description: "select the next Fact in the tree map lens",
    requires: (context) => context.mapFactLens === true,
    searchTerms: ["next lensed fact", "cycle fact lens", "lens next"]
  },
  {
    id: "map-close-fact-lens", section: "view", name: "close Fact lens",
    description: "close the Fact lens and keep the tree map open",
    requires: (context) => context.mapFactLens === true,
    searchTerms: ["close lens", "hide fact lens", "map lens close"]
  },
  {
    id: "map-open-fact-lens-anchor", section: "view", name: "open lensed Fact Anchor",
    description: "jump from the map lens to its selected anchor",
    requires: (context) => context.mapFactLens === true,
    searchTerms: ["open lens anchor", "map fact anchor"]
  },
  {
    id: "map-edit-fact-lens", section: "view", name: "edit lensed Fact State",
    description: "edit the Fact State at the map cursor",
    requires: (context) => context.mapFactLens === true,
    searchTerms: ["edit lensed fact", "map fact state", "lens edit"]
  }
];

/** Derive only the Fact-editor state needed by contextual palette commands.
 *  The editor reducer remains the authority for whether an action is valid. */
export function factEditorPaletteContext(
  editor: FactEditorSession | null | undefined
): Pick<CommandPaletteContext,
  "factEditor" | "factEditorStateful" | "factEditorHasState"
  | "factEditorStateCreating" | "factEditorCanOpenAnchor" | "factEditorCanDeleteState"> {
  const factEditor = editor?.kind === "fact";
  const stateful = factEditor && (editor.target.factId !== null || editor.stateCreating === true);
  const hasState = stateful && editor.stateId !== undefined && editor.stateId !== null;
  return {
    factEditor,
    factEditorStateful: stateful,
    factEditorHasState: hasState,
    factEditorStateCreating: factEditor && editor.stateCreating === true,
    factEditorCanOpenAnchor: hasState && editor.stateAnchorPartId != null,
    factEditorCanDeleteState: hasState && editor.stateCreating !== true && editor.target.factId !== null
  };
}
