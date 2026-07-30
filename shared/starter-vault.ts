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
          instruction: "Open the tour. Teach take flipping by making the reader do it.",
          keys: ["takeNext", "takePrevious"],
          text: STARTER_LOGO_TEXT + "\n\n"
            + "Welcome to 1667. This story is also the manual, which means you can "
            + "ruin it freely, and you can delete both starter "
            + "stories the moment they stop being useful.\n\n"
            + "Start with the thing that makes this editor different. This paragraph exists in "
            + "three versions. They are called takes. Press [→] to read the next one, and [←] "
            + "to come back.\n\n"
            + "Flipping costs nothing. Every take stays exactly where it is, and the one left "
            + "on screen is simply the one the story reads as its own."
        },
        {
          slug: "open-2",
          instruction: "Second take. Same beat, plainer voice, so the difference is felt.",
          keys: ["takeNext", "takePrevious"],
          text: "Take two of three.\n\n"
            + "Same moment in the story, different words for it. That is all a take is: an "
            + "alternative for one beat, not a fork of the whole book. You will accumulate "
            + "them without meaning to. Every regeneration lands here, beside its siblings, "
            + "rather than on top of them.\n\n"
            + "Nothing you have read so far was overwritten to show you this. Press [→] for "
            + "the last one, or [←] to go back."
        },
        {
          slug: "open-3",
          instruction: "Third take. Close the row and hand the reader downward.",
          tag: { name: "The long way round", status: "Alt" },
          keys: ["takeNext", "takePrevious", "focusNext"],
          text: "Take three, and the end of the row — [→] stops here, and [←] walks back.\n\n"
            + "This one has a tag on it, named \"The long way round\". You will see it "
            + "again in the map later: a tag is how you make one take "
            + "findable months later, when you have forgotten it existed.\n\n"
            + "Now go back to the first take with [←]. And then press [↓]."
        }
      ]
    },
    {
      takes: [
        {
          slug: "moving",
          instruction: "Movement: focus versus viewport.",
          keys: ["focusNext", "focusPrevious", "scrollLineDown", "scrollLineUp", "top", "leaf"],
          text: "[↓] and [↑] move between parts.\n\n"
            + "The focused part is highlighted. It's the one every other key acts on. "
            + "Tagging, regenerating, editing, deleting — they "
            + "all aim at whatever is focused right now.\n\n"
            + "Reading is a separate motion. Hold shift and the view slides without dragging "
            + "focus along: [⇧↓] and [⇧↑] nudge it one line. To travel further, [g] jumps to "
            + "the top of the story and [G] runs to the end of the story line you are on.\n\n"
            + "Keep going down."
        }
      ]
    },
    {
      takes: [
        {
          slug: "writing",
          instruction: "Introduce the two ways prose arrives.",
          keys: ["continue", "compose", "write", "regenerate", "reprompt"],
          text: "Prose arrives two ways, and both are one keystroke.\n\n"
            + "Press [space] to continue from here. No instruction, no ceremony, just carry "
            + "on. Press [enter] instead when you want to say something first: describe the "
            + "next beat, then send it.\n\n"
            + "This install is wired to a dry-run model, so anything you generate comes back "
            + "as obvious placeholder text rather than a bill. Connect a "
            + "real model whenever you like. The tour tells you where, further down.\n\n"
            + "When a result disappoints, [r] regenerates it as a new take beside the old "
            + "one, and [R] regenerates with a fresh instruction. The disappointing version "
            + "does not vanish; it just stops being the one on screen.\n\n"
            + "To write in your own hand rather than the model's, press [w]."
        }
      ]
    },
    {
      takes: [
        {
          slug: "revising",
          instruction: "Editing, undo, and pruning — the destructive end of the keyboard.",
          keys: ["edit", "takePrevious", "undo", "prune", "instructions"],
          text: "Press [e] to edit the focused part in place. Your changes become a take, so "
            + "the model's original stays reachable behind [←].\n\n"
            + "[u] takes back a chapter break you made or removed, and only that. There is no "
            + "undo for prose, so read the next sentence twice. [d] prunes — it deletes takes "
            + "and their children, which is how a story that sprawled during a long session "
            + "gets its shape back. Pruning asks first if you are sure, and [u] will not bring "
            + "back what it takes.\n\n"
            + "One more: [p] toggles the instructions that produced each part. Try it here. "
            + "Every part in this tour carries the note it was written against, which is "
            + "usually the fastest way to remember what you were trying to do."
        }
      ]
    },
    {
      chapter: "The Map",
      takes: [
        {
          slug: "map",
          instruction: "The map, and why it exists.",
          keys: ["openMap", "mapCycleView", "mapClose", "mapDetail", "mapJump", "mapTag"],
          text: "Press [m] to open the map.\n\n"
            + "A story with takes is a tree, not a page, and past a few thousand words the "
            + "tree is the real picture of it. The map draws that tree: the line you "
            + "are reading, the takes hanging off it, the tags you left behind.\n\n"
            + "Inside the map, [m] cycles between its views, [esc] closes it, [a] turns "
            + "detail up or down, and [t] tags whatever row you are on. Press [enter] "
            + "to jump the story to that row and land back in the text exactly there.\n\n"
            + "Tags go on the end of a story line, never in the middle: you are naming "
            + "where a storyline arrived, not annotating a paragraph. Two of them are already out "
            + "there — one on the take you skipped at the start, one at the end of this tour. "
            + "Each tag carries a status: Canon, Alt, Draft, Discarded, Summary. Use them "
            + "loosely — they sort the map, they do not police anything. Name a second line "
            + "Canon and the first one steps down to Alt, keeping its name."
        }
      ]
    },
    {
      takes: [
        {
          slug: "chapters",
          instruction: "Chapters as context boundaries, not decoration.",
          keys: ["openChapters", "createChapter"],
          text: "You crossed a chapter break a moment ago: the part about the map opens a "
            + "chapter called \"The Map\", and you are inside it now.\n\n"
            + "Press [c] to see the chapters in this story, and [C] to start a new one at the "
            + "focused part. Chapters are not decoration. They bound what gets sent to the "
            + "model, so a long book stays affordable: earlier chapters can be summarised "
            + "once and then travel as a summary rather than as forty thousand words.\n\n"
            + "For a story this short you will never need them. For the one you are about to "
            + "write, you will."
        }
      ]
    },
    {
      takes: [
        {
          slug: "elsewhere",
          instruction: "The remaining overlays, briefly, without drowning the reader.",
          keys: ["openLibrary", "openFacts", "actions", "commands", "settings", "keys"],
          text: "The rest of the surface, quickly.\n\n"
            + "[o] opens the library — every story you have, including the second starter "
            + "story sitting next to this one. That is how you switch.\n\n"
            + "[f] holds facts: the names, places, and rules you want kept straight, sent "
            + "with every request that writes prose so the model stops renaming your "
            + "characters. A fact can "
            + "carry a tag of its own: a short word for sorting your facts, which is a "
            + "different thing from tagging a story line back in the map. There are a few "
            + "in here already, and the hedge story next door keeps the kind you will "
            + "actually write.\n\n"
            + "[x] opens a menu of whatever applies to the focused part, for the days you "
            + "would rather point than recall. [:] is the command palette, which can reach "
            + "things no key is bound to.\n\n"
            + "[,] opens settings — that is where you connect a real model in place of the "
            + "dry-run one.\n\n"
            + "And [?] is the key reference: the keys grouped by what they are for, each "
            + "beside a line saying what it does. If you remember one key from this tour, "
            + "remember that one."
        }
      ]
    },
    {
      takes: [
        {
          slug: "ending",
          instruction: "Close the tour. Give explicit permission to delete it.",
          tag: { name: "End of the tour", status: "Canon" },
          keys: ["openLibrary", "newStory", "quit"],
          text: "That is the whole instrument.\n\n"
            + "Next door is \"A Door in the Hedge\" — one paragraph, no takes, nothing "
            + "explained. Press [o] and open it if you want somewhere already warm to start. "
            + "Press [n] for a story of your own if you would rather begin cold.\n\n"
            + "When this tour has taught you what it can, delete it. Open the library with "
            + "[o] and remove it there. A starter story that outstays its welcome is just "
            + "clutter with sentimental value.\n\n"
            + "[q] quits, and everything is already saved.\n\n"
            + "Go and write something."
        },
        {
          slug: "ending-alt",
          instruction: "A shorter goodbye, kept as a second take so the last beat also has a row.",
          tag: { name: "Short goodbye", status: "Draft" },
          keys: ["keys"],
          text: "Or, the short version:\n\n"
            + "Arrows move. Space continues. Everything else is on [?].\n\n"
            + "Delete this story whenever you like."
        }
      ]
    }
  ],
  // The tour's facts describe the instrument, because the tour is the manual and
  // a fact must be true of the story that carries it. The hedge story next door
  // carries the other kind, which is the kind the reader will write.
  facts: [
    {
      slug: "fixed-context",
      tag: "how facts work",
      text: "Facts are fixed context\n"
        + "Every fact in this list travels with every request that writes prose, whole and "
        + "unsummarised. That is what keeps a name spelled the same way in chapter nine as in "
        + "chapter one. Chapter summaries are the exception: they are written from the prose "
        + "alone, so nothing you record here can bend a recap of what already happened."
    },
    {
      slug: "fact-shape",
      tag: "how facts work",
      text: "The first line is the name\n"
        + "A fact is one block of text. Its first line names it in this list, and the lines "
        + "under it are the body. Short name, specific body."
    },
    {
      slug: "fact-tag",
      tag: "how facts work",
      text: "A tag sorts this list, and the model reads it\n"
        + "The tag on a fact fills the chips at the top of this overlay, and it travels beside "
        + "the fact in every request. A tag like \"rules\" tells the model what kind of thing it "
        + "is holding, so write tags you would be content to have read back to you. It is a "
        + "different thing from the tag you leave on a story line in the map."
    },
    {
      slug: "fact-cost",
      tag: "upkeep",
      text: "A fact you never need is one you pay for every time\n"
        + "Facts are the one part of the prompt that never gets shorter as the book grows. "
        + "Prune this list the way you prune takes."
    },
    {
      slug: "fact-examples",
      tag: "upkeep",
      text: "These are examples\n"
        + "Delete them once the shape is obvious. Facts belong to one story, so removing these "
        + "leaves the hedge story's own facts where they are."
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
          text: "The hedge had been there longer than the house, and the door had been in the "
            + "hedge longer than either — a low green door, latched, with hinges that nobody "
            + "living remembered oiling.\n\n"
            + "Every gardener since the war had trimmed around it. None of them had opened "
            + "it. This was not superstition exactly. It was more that opening it had never "
            + "once been the most pressing thing to do that afternoon, and afternoons, as "
            + "everyone knows, are how a life gets spent.\n\n"
            + "This morning the latch was on the wrong side."
        }
      ]
    }
  ],
  // Written the way a reader's own facts should read: what the model must not
  // get wrong about a story that is one paragraph old.
  facts: [
    {
      slug: "hedge",
      tag: "places",
      text: "The hedge\n"
        + "Older than the house. Every gardener since the war has trimmed around it, and none "
        + "has cut it back far enough to find where it ends."
    },
    {
      slug: "door",
      tag: "places",
      text: "The green door\n"
        + "Low, latched, set into the hedge. The hinges have not been oiled in living memory. "
        + "The latch was on the garden side until this morning."
    },
    {
      slug: "gardener",
      tag: "people",
      text: "The gardener\n"
        + "The latest of a line of them. Trims around the door twice a year. Has never opened it, "
        + "and does not think of this as a decision."
    },
    {
      slug: "house-habit",
      tag: "rules",
      text: "Nobody in the house discusses the door\n"
        + "This is habit, not fear. Opening it has never once been the most pressing thing to do "
        + "that afternoon. Write it that way: no one warns anybody."
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
