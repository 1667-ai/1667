import {
  REFERENCE_BINDINGS,
  type ReferenceBinding,
  type ReferenceBindingId
} from "./reference-bindings.js";
import type { DisplayRole } from "./screens/story/frame.js";

export type KeysModalBinding = ReferenceBinding;

/** One row of the reference: the keys as a writer would spell them, and what
 *  pressing them does. Every row carries the bindings it claims, so the
 *  resolver-contract tests fail rather than let the copy drift from reality. */
export interface KeysModalEntry {
  token: string;
  description: string;
  bindings: readonly KeysModalBinding[];
}

export interface KeysModalSection {
  title: string;
  blurb: string;
  role: DisplayRole;
  entries: readonly KeysModalEntry[];
}

export interface KeysModalModel {
  sections: readonly KeysModalSection[];
  bindings: readonly KeysModalBinding[];
}

const binding = (id: ReferenceBindingId): KeysModalBinding =>
  REFERENCE_BINDINGS[id];

const entry = (
  description: string,
  bindings: readonly KeysModalBinding[]
): KeysModalEntry => ({
  token: [...new Set(bindings.map((item) => item.display))].join(" "),
  description,
  bindings
});

/** The whole key reference, as sections a writer can read top to bottom.
 *
 * This replaced a QWERTY diagram that coloured caps by band and left most of
 * them unexplained: it cost eight rows and half the panel width to say where
 * `r` sits on the keyboard, which is the one thing nobody needs told. Every
 * key that does something now states what it does, in the same voice as the
 * command palette.
 *
 * Descriptions stay within DESCRIPTION_BUDGET cells so two columns fit an
 * 80-column terminal without truncation; keep new copy inside it. */
const SECTIONS: readonly KeysModalSection[] = [
  {
    title: "MOVE",
    blurb: "read and navigate",
    role: "focus / accent",
    entries: [
      entry("previous · next row", [
        binding("navFocusPrevious"),
        binding("navFocusNext"),
        binding("mapFocusPrevious"),
        binding("mapFocusNext")
      ]),
      entry("flip between takes", [
        binding("navTakePrevious"),
        binding("navTakeNext"),
        binding("mapPathTakePrevious"),
        binding("mapPathTakeNext")
      ]),
      entry("nudge the page a line", [
        binding("navScrollLineUp"),
        binding("navScrollLineDown")
      ]),
      entry("page up", [
        binding("navPageUp"),
        binding("navCtrlPageUp")
      ]),
      entry("page down", [
        binding("navPageDown"),
        binding("navCtrlPageDown")
      ]),
      entry("first part · last part", [
        binding("navTop"),
        binding("navLeaf")
      ]),
      entry("chapter back · forward", [
        binding("navChapterPrevious"),
        binding("navChapterNext")
      ]),
      // Undo reaches an added or removed chapter break, and nothing else. Name
      // both operations rather than the category: a chapter rename and a
      // summary edit are chapter changes too, and neither one is undoable. It
      // must not read as a safety net beside `d`, which it cannot reverse.
      // Take switching stays off this list on purpose — the arrows already walk
      // the row, and pairing them under one word taught that `u` reaches back
      // into prose.
      entry("undo break add · remove", [binding("navUndo")])
    ]
  },
  {
    title: "WRITE",
    blurb: "make the next part",
    role: "human edit",
    entries: [
      entry("continue this part", [binding("navContinue")]),
      entry("type what happens next", [
        binding("navComposeEnter"),
        binding("navComposeI")
      ]),
      entry("retake · same prompt", [binding("navRegenerate")]),
      entry("retake · edit prompt", [
        binding("navRetakeWithPrompt")
      ]),
      entry("write a take yourself", [binding("navWrite")]),
      entry("edit prose and prompt", [binding("navEdit")]),
      entry("author's note", [binding("navAuthorsNote")]),
      entry("copy part · whole line", [
        binding("navCopyPart"),
        binding("navCopyLine")
      ]),
      entry("past prompts, in direct", [
        binding("composeHistoryPrevious"),
        binding("composeHistoryNext")
      ])
    ]
  },
  {
    title: "SHAPE",
    blurb: "arrange what exists",
    role: "tag · alt",
    entries: [
      entry("delete take and below", [binding("navPrune")]),
      entry("tag the line here", [binding("navTag")]),
      entry("chapters · end one here", [
        binding("navOpenChapters"),
        binding("navCreateChapter")
      ]),
      entry("actions for this part", [binding("navOpenActions")]),
      entry("show or hide directions", [binding("navToggleInstructions")]),
      entry("show or hide a thought", [binding("navToggleThought")]),
      entry("typewriter mode", [binding("navTypewriter")]),
      entry("facts rail · auto or off", [
        binding("navToggleRail")
      ])
    ]
  },
  {
    title: "OPEN",
    blurb: "panels and views",
    role: "tag · canon",
    entries: [
      entry("map of the whole story", [binding("navOpenMap")]),
      entry("facts kept for context", [binding("navOpenFacts")]),
      entry("aside", [binding("navAside")]),
      entry("switch story · library", [binding("navOpenLibrary")]),
      entry("command palette", [
        binding("navOpenCommandsColon"),
        binding("navOpenCommandsCtrlP")
      ]),
      entry("search story or vault", [binding("navOpenSearch")]),
      entry("generation settings", [binding("navOpenSettings")]),
      entry("wide context details", [
        binding("navToggleContext"),
        binding("composeToggleContext")
      ]),
      entry("inspect the next request", [
        binding("navOpenRequest"),
        binding("composeOpenRequest")
      ]),
      // "probabilities" alone breaks the minimum-width panel's word wrap
      // (no hyphenation, and nothing else in this reference runs past ten
      // letters), so this reads the feature's purpose, not its noun.
      entry("how sure the model was", [binding("navOpenProbs")]),
      entry("past model requests", [
        binding("navOpenRecords"),
        binding("mapOpenRecords")
      ]),
      entry("everything the app said", [
        binding("navOpenLog"),
        binding("navOpenLogShifted"),
        binding("mapOpenLog"),
        binding("mapOpenLogShifted")
      ]),
      entry("this key reference", [
        binding("navOpenKeysQuestion"),
        binding("navOpenKeysShiftSlash")
      ]),
      entry("close what is open", [
        binding("navClose"),
        binding("mapClose"),
        binding("keysClose"),
        binding("logClose"),
        binding("searchClose"),
        binding("cardClose")
      ]),
      entry("quit 1667", [binding("navQuit")])
    ]
  },
  {
    title: "MAP",
    blurb: "while the map is open",
    role: "compose accent",
    entries: [
      entry("cycle path · tree · mass", [binding("mapCycleView")]),
      entry("lens one Fact in tree", [binding("mapOpenFactLens")]),
      entry("all takes · sketches", [
        binding("mapPathAllTakes"),
        binding("mapTreeSketches"),
        binding("mapMassSketches")
      ]),
      entry("reroute node or sketch", [binding("mapApply")]),
      // Views the map itself names in its tabs. A key that does nothing in the
      // view you are looking at has to say so, or the reference lies again.
      entry("follow tree · open mass", [
        binding("mapTreeFollow"),
        binding("mapMassFollow")
      ]),
      entry("tree · jump to next lane", [
        binding("mapTreeLanePrevious"),
        binding("mapTreeLaneNext")
      ]),
      entry("hide tree lanes · path", [binding("mapTreePath")]),
      entry("sort the mass view", [binding("mapMassSort")]),
      entry("prune · tag · path", [
        binding("mapPathPrune"),
        binding("mapPathTag")
      ])
    ]
  },
  {
    title: "SEARCH",
    blurb: "while search is open",
    role: "tag · draft",
    entries: [
      entry("previous · next hit", [
        binding("searchFocusPrevious"),
        binding("searchFocusNext")
      ]),
      entry("fold · open a group", [
        binding("searchFold"),
        binding("searchUnfold")
      ]),
      entry("this tree · whole vault", [binding("searchScope")]),
      entry("go to the hit", [binding("searchOpen")]),
      // The query field takes every plain letter, so this one has to be a
      // chord — say so here, where a reader looks for the missing `c`.
      entry("match case exactly", [binding("searchCase")])
    ]
  }
];

export const KEYS_MODAL_MODEL: KeysModalModel = {
  sections: SECTIONS,
  bindings: SECTIONS.flatMap((section) => section.entries.flatMap((item) => item.bindings))
};
