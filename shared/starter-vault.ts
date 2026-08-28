import type { StarterKeyId } from "./starter-keys.js";
import type { TagStatus } from "./types.js";

/**
 * Content for the two stories a fresh data directory opens with.
 *
 * This module is the only source of truth for the starter prose. The seeder
 * replays it through the ordinary create/tag/chapter paths, so the vault
 * is always written in the current schema instead of thawing a snapshot that
 * rots at the next migration.
 *
 * Every key named in the prose is declared in `./starter-keys.js` and spelled
 * `[token]` in the text.
 */

export interface StarterTake {
  /** Stable slug; the seeder derives a deterministic node id from it. */
  readonly slug: string;
  readonly text: string;
  /** Recorded per part and revealed by the instructions toggle. */
  readonly instruction?: string;
  readonly tag?: { readonly name: string; readonly status: TagStatus };
  /** Keys this take's prose teaches. Must match its `[token]` spellings. */
  readonly keys?: readonly StarterKeyId[];
}

export interface StarterBeat {
  /** Alternatives for one position. The first take carries the line onward, so a
   * beat always has at least one; an empty beat would re-root the story. */
  readonly takes: readonly [StarterTake, ...StarterTake[]];
  /** Opens a chapter whose break sits above this beat. */
  readonly chapter?: string;
}

/** A fact the facts overlay opens with. The first line of `text` is the name
 * the overlay lists; the rest is the body. */
export interface StarterFact {
  /** Stable slug; the seeder derives a deterministic fact id from it. */
  readonly slug: string;
  /** Sorts the fact into a chip at the top of the overlay. */
  readonly tag: string;
  readonly text: string;
  /** Keys this fact's text teaches. Must match its `[token]` spellings. */
  readonly keys?: readonly StarterKeyId[];
}

export interface StarterStory {
  readonly id: string;
  readonly title: string;
  readonly beats: readonly StarterBeat[];
  /** Seeded in the same aggregate change as the prose. */
  readonly facts: readonly StarterFact[];
}

/** A small story-native version of the 1667 mark. The TUI gives these five
 * exact lines the rainbow treatment. Every other surface gets plain text. */
const logoLine = (indent: number, mark: string): string =>
  // U+2800 occupies one terminal cell and survives normal story trim rules.
  "\u2800".repeat(indent) + mark;

export const STARTER_LOGO_LINES = [
  logoLine(3, "_  __    __ _____"),
  logoLine(2, "/ |/ /_  / /|___  |"),
  logoLine(2, "| | '_ \\| '_ \\ / /"),
  logoLine(2, "| | (_) | (_) / /"),
  logoLine(2, "|_|\\___/ \\___/_/")
] as const;

export const STARTER_LOGO_TEXT = STARTER_LOGO_LINES.join("\n");

const TOUR: StarterStory = {
  id: "1a9c7e64-5f3b-4d2a-9c81-0e6b4f7a2d13",
  title: "Start Here",
  beats: [
    {
      takes: [
        {
          slug: "open-1",
          instruction: "Show how to move between takes.",
          keys: ["takeNext", "takePrevious"],
          text: STARTER_LOGO_TEXT + "\n\n"
            + "Welcome to 1667. This story is a short tour. You can edit or delete both "
            + "starter stories at any time.\n\n"
            + "This story part has three takes. A take is an alternative version of one "
            + "story part. Press [→] to read the next take. Press [←] to return.\n\n"
            + "1667 keeps every take. The take on screen is part of the selected story line."
        },
        {
          slug: "open-2",
          instruction: "Show that a take changes only one story part.",
          keys: ["takeNext", "takePrevious"],
          text: "Take two of three covers the same point in different words.\n\n"
            + "A take changes one story part, "
            + "not the rest of the story. New retakes appear beside the current take. They "
            + "do not replace it.\n\n"
            + "Press [→] for the last take. Press [←] to return."
        },
        {
          slug: "open-3",
          instruction: "Show the end of a take row and introduce tags.",
          tag: { name: "The long way round", status: "Alt" },
          keys: ["takeNext", "takePrevious", "focusNext"],
          text: "Take three is the last take in this row. [→] stops here, and [←] moves back.\n\n"
            + "The story line that ends here has the tag \"The long way round\". Tags help "
            + "you find a story line in the map.\n\n"
            + "Press [←] until you return to the first take. Then press [↓]."
        }
      ]
    },
    {
      takes: [
        {
          slug: "moving",
          instruction: "Show how focus and scrolling work.",
          keys: ["focusNext", "focusPrevious", "scrollLineDown", "scrollLineUp", "top", "leaf"],
          text: "Press [↓] or [↑] to move between story parts.\n\n"
            + "The focused part is highlighted. Edit, retake, tag, and delete actions apply "
            + "to that part.\n\n"
            + "Use [⇧↓] or [⇧↑] to scroll one line without moving the focus. [g] goes to "
            + "the first story part. [G] goes to the last part of the selected "
            + "story line.\n\n"
            + "Press [↓] to continue."
        }
      ]
    },
    {
      takes: [
        {
          slug: "writing",
          instruction: "Show manual writing and model generation.",
          keys: ["continue", "compose", "write", "regenerate", "reprompt"],
          text: "You can write a take yourself or ask a model to write one.\n\n"
            + "[w] opens an editor for your own take. [space] asks the selected provider to "
            + "continue the story. [enter] lets you give a direction before the request.\n\n"
            + "The tour starts with a dry-run provider. It returns placeholder text and does "
            + "not contact an external service. You can select a provider later in Settings.\n\n"
            + "Press [r] to request another take with the same direction. Press [R] to change "
            + "the direction first. 1667 keeps the earlier take."
        }
      ]
    },
    {
      takes: [
        {
          slug: "revising",
          instruction: "Show editing, chapter undo, pruning, and saved directions.",
          keys: ["edit", "takePrevious", "undo", "prune", "instructions"],
          text: "Press [e] to edit the focused part. By default, 1667 saves the edit as a new "
            + "take. Press [←] to return to the earlier take.\n\n"
            + "Press [u] to restore the last chapter break that you added or removed. It does "
            + "not undo prose changes. Press [D] to delete the focused take and its children. "
            + "1667 asks for confirmation because the deletion is permanent.\n\n"
            + "Press [p] to show or hide the saved direction for each story part. The tour "
            + "includes a direction for every part."
        }
      ]
    },
    {
      chapter: "The Map",
      takes: [
        {
          slug: "map",
          instruction: "Show the map views and story-line tags.",
          keys: ["openMap", "mapCycleView", "mapClose", "mapDetail", "mapJump", "mapTag"],
          text: "Press [m] to open the map.\n\n"
            + "The map shows the selected story line, the other takes, and the tags. [m] "
            + "changes the map view. [a] changes the detail level. [enter] opens the selected "
            + "story part. [esc] closes the map.\n\n"
            + "Press [t] to tag the selected story line. A tag has a name and one status: "
            + "Canon, Alt, Draft, Discarded, or Summary. A story can have only one Canon line. "
            + "If you set a second line to Canon, the first line becomes Alt."
        }
      ]
    },
    {
      takes: [
        {
          slug: "chapters",
          instruction: "Show chapter navigation and chapter context.",
          keys: ["openChapters", "createChapter"],
          text: "The previous story part starts a chapter named \"The Map\".\n\n"
            + "Press [c] to open the Chapters view. Press [C] to start a chapter at the "
            + "focused part.\n\n"
            + "Chapters also organize provider context. 1667 can use a summary for an earlier "
            + "chapter instead of sending all of its prose. Add chapters as your story grows."
        }
      ]
    },
    {
      takes: [
        {
          slug: "elsewhere",
          instruction: "Show the main panels and references.",
          keys: ["openLibrary", "openFacts", "actions", "commands", "settings", "keys"],
          text: "Press [o] to open the Library and select another story. The Library includes "
            + "the second starter story.\n\n"
            + "Press [f] to open Facts. Use Facts for names, places, items, and rules that a "
            + "provider can use when it writes prose. A Fact tag sorts Facts. It is separate "
            + "from a story-line tag. Both starter stories include examples.\n\n"
            + "Press [x] to show actions for the focused story part. Press [:] to open the "
            + "command palette.\n\n"
            + "Press [,] to open Settings and select a provider.\n\n"
            + "Press [?] to open the complete key reference."
        }
      ]
    },
    {
      takes: [
        {
          slug: "ending",
          instruction: "Explain how to remove the tour and select a provider.",
          tag: { name: "End of the tour", status: "Canon" },
          keys: ["openLibrary", "deleteStory", "settings"],
          text: "The tour is complete.\n\n"
            + "To delete a starter story, press [o]. Select the story, then press [D].\n\n"
            + "To connect a model, press [,]. Open Connection, then select a Provider. You do "
            + "not need a provider to write or edit your own takes."
        },
        {
          slug: "ending-alt",
          instruction: "End with a short key reminder.",
          tag: { name: "Short goodbye", status: "Draft" },
          keys: ["keys"],
          text: "Use the arrow keys to move. Press Space to request a continuation. Press [?] "
            + "to see every key.\n\nDelete this story when you no longer need it."
        }
      ]
    }
  ],
  // The tour's facts explain Facts. The second starter story shows Facts for
  // fictional people, places, and rules.
  facts: [
    {
      slug: "fixed-context",
      tag: "how facts work",
      text: "Facts can enter provider context\n"
        + "An always-active Fact enters each continuation and rewrite request. A keyed Fact "
        + "enters a request only when the context matches one of its keys. 1667 sends each "
        + "included Fact as one complete block."
    },
    {
      slug: "fact-shape",
      tag: "how facts work",
      text: "The first line is the name\n"
        + "A Fact is one block of text. The first line names the Fact in this list. The other "
        + "lines contain its details."
    },
    {
      slug: "fact-tag",
      tag: "how facts work",
      text: "A Fact tag sorts the list\n"
        + "A Fact tag creates a filter at the top of the Facts panel. It can also enter a "
        + "provider request with the Fact. A Fact tag is separate from a story-line tag."
    },
    {
      slug: "fact-cost",
      tag: "upkeep",
      text: "Remove Facts that you no longer need\n"
        + "Each included Fact uses part of the provider context. Use activation keys, "
        + "priorities, and budgets to control which Facts 1667 includes."
    },
    {
      slug: "fact-examples",
      tag: "upkeep",
      text: "Delete these example Facts when you are ready\n"
        + "Facts belong to one story. Deleting these Facts does not change the Facts in the "
        + "second starter story."
    }
  ]
};

const SEED: StarterStory = {
  id: "2f5d8c31-7a44-4e19-b6d2-8c3f1e50a97b",
  title: "A Door in the Hedge",
  beats: [
    {
      takes: [
        {
          slug: "hedge",
          instruction: "Continue the story.",
          text: "The hedge was older than the house. A low green door sat inside it, latched "
            + "and half-covered by leaves. No one alive remembered oiling its hinges.\n\n"
            + "Every gardener since the war had trimmed around the door. None had opened it. "
            + "There was always work to finish before sunset, and the door could wait until "
            + "tomorrow.\n\n"
            + "This morning, the latch was on the wrong side."
        }
      ]
    }
  ],
  // These Facts show the form that writers can use for fictional reference
  // material.
  facts: [
    {
      slug: "hedge",
      tag: "places",
      text: "The hedge\n"
        + "The hedge is older than the house. Every gardener since the war has trimmed around "
        + "it. No one has cut it back far enough to find where it ends."
    },
    {
      slug: "door",
      tag: "places",
      text: "The green door\n"
        + "The door is low, latched, and half-covered by leaves. Its hinges have not been "
        + "oiled in living memory. The latch was on the garden side until this morning."
    },
    {
      slug: "gardener",
      tag: "people",
      text: "The gardener\n"
        + "The current gardener trims around the door twice each year. The gardener has never "
        + "opened it and does not think of this as a decision."
    },
    {
      slug: "house-habit",
      tag: "rules",
      text: "No one in the house discusses the door\n"
        + "The people in the house are busy, not afraid. No one warns the gardener about the "
        + "door."
    }
  ]
};

/** Both starter stories, in the order a fresh library lists them. */
export const STARTER_STORIES: readonly StarterStory[] = [TOUR, SEED];

/** Every piece of starter prose, whatever surface carries it, with the keys it
 *  declares. The key contract walks this rather than the beats, so prose added
 *  to a new surface is checked by the same tests instead of quietly escaping
 *  them. */
export function starterProse(): { slug: string; text: string; keys: readonly StarterKeyId[] }[] {
  return STARTER_STORIES.flatMap((story) => [
    ...story.beats.flatMap((beat) => beat.takes.map((take) => ({
      slug: take.slug, text: take.text, keys: take.keys ?? []
    }))),
    ...story.facts.map((fact) => ({
      slug: `fact:${fact.slug}`, text: fact.text, keys: fact.keys ?? []
    }))
  ]);
}

/** The story a fresh install opens on. Also the only story that opens at its
 *  first part when no local reading position is stored yet (issue #38). */
export const STARTER_OPENING_STORY_ID = TOUR.id;
