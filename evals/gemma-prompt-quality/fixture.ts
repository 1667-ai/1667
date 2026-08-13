import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AuthorsNotePlacement } from "../../shared/authors-note.js";
import type { PromptPlan } from "../../shared/prompt-plan.js";
import type { ChapterBreak, StoryNode } from "../../shared/types.js";
import { GEMMA_REPLAY_SEEDS } from "./contract.js";
import type { GemmaReplayOperation } from "./contract.js";

/** The sample seeds are part of the replay contract. Do not add a seed here
 * without also updating the scorer and the compatibility gate. */
export { GEMMA_REPLAY_SEEDS } from "./contract.js";

export type { GemmaReplayOperation } from "./contract.js";

export interface GemmaOperationFixture {
  readonly operation: GemmaReplayOperation;
  readonly targetId: string;
  readonly instruction: string;
  readonly appendLast: boolean;
  readonly context: readonly StoryNode[];
  /** Expected v0.8 chapter assembly. Keep this independent from live code. */
  readonly baselineContext: readonly StoryNode[];
  /** The fixture must exercise note placement, not only prompt text. */
  readonly authorsNote: AuthorsNotePlacement;
  /** The fixture must exercise chapter-summary replacement. */
  readonly chapterBreaks: readonly ChapterBreak[];
  readonly nodes: readonly StoryNode[];
}

/** Text that the blind scorer needs in order to score an output. Keep this
 * text free of a baseline or candidate label. */
export const GEMMA_SCORING_CONTEXT = Object.freeze({
  voice: "Close third person. Past tense. Restrained, tactile prose. Vary short and long sentences.",
  facts: [
    "Mara Vale is the bell keeper of Greywater Reach.",
    "The brass compass belonged to Ivo, Mara's missing brother, who remains beyond the collapsed tower.",
    "The drowned bell cracked when Ivo stayed in the tower; the eastern marsh still carries its danger.",
    "The salt flats are dangerous after the second bell.",
    "Mara promised the ferryman Jun that she would return before moonrise."
  ],
  genericReset: "A generic scene reset includes a new morning, an unnamed room, stock weather, or a fresh character introduction that ignores the established scene."
} as const);

export const GEMMA_AUTHOR_BRIEF =
  "Write close third-person past-tense fiction with restrained, tactile language. "
  + "Keep Mara's established voice and vary short and long sentences. "
  + "Do not explain the story or use headings.";

export const GEMMA_FACTS_BLOCK = [
  "Established facts:",
  ...GEMMA_SCORING_CONTEXT.facts.map((fact) => `- ${fact}`)
].join("\n");

/** The replay uses bytes because the endpoint tokenizer is not available here. */
export const GEMMA_MINIMUM_RENDERED_CONTEXT_BYTES = 20_000;
const GEMMA_LONG_STORY_PROSE = readFileSync(
  fileURLToPath(new URL("./gemma-long-story.txt", import.meta.url)),
  "utf8"
).trim();

/** A fixed, long context. The named facts and the final seam make each sample
 * scoreable without relying on an old model output. */
export const GEMMA_LONG_STORY: readonly StoryNode[] = Object.freeze([
  node("p01", null, "Find the bell tower before the tide turns.",
    "Mara Vale reached Greywater Reach while the last light thinned over the salt flats. The bell tower stood beyond the reeds, black against a sky the colour of worn pewter. She kept one hand on the brass compass that had belonged to her missing brother, Ivo. Its needle pointed east, although east was only water and mud here. She had promised Jun, the ferryman, that she would return before moonrise. Jun had laughed when she made the promise. He had not laughed when he saw the compass tremble."),
  node("p02", "p01", "Let the marsh answer her first question.",
    "At the reed line, the wind stopped. The silence was not empty. It gathered around her boots and climbed her coat, carrying the mineral smell of a shore that had withdrawn centuries ago. Mara crouched and pressed two fingers into the mud. Beneath the cold skin of it, something pulsed once. The compass glass clouded. She looked toward the tower and saw a thread of lamp smoke rise from its broken crown, though no lamp had burned there since the eastern marsh swallowed the old village."),
  node("p03", "p02", "Bring the old warning into focus.",
    "She crossed on the narrow stones, counting them under her breath. The third stone shifted, and the marsh opened a dark mouth beside her knee. Mara caught the tower rope and held fast until the water closed. A scrap of red cloth clung to the rope's knot. Ivo had worn a red scarf on the day he vanished. She told herself that cloth could travel. The lie had a thin, useful shape, and for three more stones she let it carry her."),
  node("p04", "p03", "Make the tower feel occupied.",
    "Inside the tower, the stair curled upward through wet dust. Someone had swept the lowest steps. The broom marks were fresh enough to shine. Mara found a cup beside the wall, still warm at its rim, and heard a careful footfall above her. She did not call out. The compass needle had settled on the stair, pointing toward the sound. From the marsh came the first low note of the drowned bell, and the tower answered with a shiver in its stones."),
  node("p05", "p04", "Give Mara a choice that costs her time.",
    "Mara climbed. Halfway up, she found Jun's lantern hanging from a nail. Its oil was gone, but a wet thumbprint darkened the brass. The ferryman had promised to wait at the south bank. He had also promised never to enter the tower. Below, the rope moved without a hand on it. Another bell note travelled through the stair, slow enough to count. Mara could descend and keep her promise, or climb toward the person who had taken Jun's lantern.\n\n" + GEMMA_LONG_STORY_PROSE),
  node("p06", "p05", "Read the warning the returned key carries.",
    "By dawn, the ferry house smelled of wet rope and burnt wick. Jun slept in the chair with his boots still on. Mara laid the child's key beside the compass and watched their brass edges touch. The key had warmed in her pocket all night. Now it pointed, not east, but toward the old chart nailed above the stove. A small mark had appeared beside the eastern channel: three short scratches, then a line. Mara copied the shape into the margin of Jun's tide book before the light could change it."),
  node("p07", "p06", "Decide whether to follow the new mark before the marsh changes again.",
    "Jun woke when Mara lifted the ferry rope from its peg. He saw the tide book open on the table and understood too quickly. The scar at his forehead had dried dark. \"The tower took enough,\" he said. Mara folded the page with the copied mark and put it inside her coat. Beyond the door, the marsh lay flat and pale, harmless only from a distance. The compass needle held steady for the first time since the tower fell. It aimed along the old shell path, where no path should have remained."),
  node("p08", "p07", "Continue from the first step toward the marked channel.",
    "Mara stepped off the ferry landing before Jun could stop her. The shell path gave softly under her boot, wet but solid. Behind her, the ferry rope creaked once and went still. She kept the compass low, following its needle between reeds silvered by dawn. At the third bend, she found a strip of red scarf caught around a black stake. It was fresh with marsh water. Mara reached for it, and the water beside the stake began to")
]);

const GEMMA_CHAPTER_BREAKS: readonly ChapterBreak[] = Object.freeze([{
  id: "chapter-one",
  parentPartId: "p04",
  title: "The Tower",
  createdAt: "2026-08-13T00:00:00.000Z"
}]);

const GEMMA_CHAPTER_SUMMARY: StoryNode = Object.freeze({
  id: "summary-chapter-one",
  parentId: "p04",
  instruction: "Inherited continuity summary of \"The Tower\" up to this point. Treat every supported detail below as established context; continue from the exact final state without retelling the summary.",
  text: "Mara entered Greywater Reach with Ivo's brass compass and promised Jun she would return before moonrise. The drowned bell began to ring. In the tower, fresh broom marks, a warm cup, and Jun's lantern showed that someone had entered. Mara climbed toward Ivo's red scarf.",
  model: "gemma-4-31b",
  createdAt: "2026-08-13T00:00:00.000Z",
  role: "summary",
  chapterBreakId: "chapter-one",
  coveredExtent: { fromPartId: "p01", toPartId: "p04" },
  madeAt: "2026-08-13T00:00:00.000Z",
  activeChildId: null
});

const GEMMA_AUTHORS_NOTE: AuthorsNotePlacement = Object.freeze({
  text: "Keep the bell's sound physical and let Mara distrust easy rescue.",
  depth: 2
});

export const GEMMA_OPERATION_FIXTURES: readonly GemmaOperationFixture[] = Object.freeze([
  Object.freeze({
    operation: "retake" as const,
    targetId: "p07",
    instruction: GEMMA_LONG_STORY[6]!.instruction,
    appendLast: false,
    context: Object.freeze(GEMMA_LONG_STORY.slice(0, 6)),
    baselineContext: Object.freeze([GEMMA_CHAPTER_SUMMARY, GEMMA_LONG_STORY[4]!, GEMMA_LONG_STORY[5]!]),
    authorsNote: GEMMA_AUTHORS_NOTE,
    chapterBreaks: GEMMA_CHAPTER_BREAKS,
    nodes: Object.freeze([...GEMMA_LONG_STORY, GEMMA_CHAPTER_SUMMARY])
  }),
  Object.freeze({
    operation: "continue" as const,
    targetId: "p08",
    instruction: "Continue the story.",
    appendLast: true,
    context: GEMMA_LONG_STORY,
    baselineContext: Object.freeze([GEMMA_CHAPTER_SUMMARY, ...GEMMA_LONG_STORY.slice(4)]),
    authorsNote: GEMMA_AUTHORS_NOTE,
    chapterBreaks: GEMMA_CHAPTER_BREAKS,
    nodes: Object.freeze([...GEMMA_LONG_STORY, GEMMA_CHAPTER_SUMMARY])
  })
]);

/** Arm-neutral context for the blind scorer. It includes the actual preceding
 * story and the seam that belongs to the selected operation. */
export interface GemmaScoringReference {
  readonly operation: GemmaReplayOperation;
  readonly targetId: string;
  readonly instruction: string;
  readonly appendLast: boolean;
  readonly mode: string;
  readonly seam: string;
  readonly context: readonly {
    readonly id: string;
    readonly instruction: string;
    readonly text: string;
  }[];
}

export const GEMMA_SCORING_REFERENCES: Readonly<Record<GemmaReplayOperation, GemmaScoringReference>> =
  Object.freeze(Object.fromEntries(GEMMA_OPERATION_FIXTURES.map((fixture) => {
    const context = fixture.context.map(({ id, instruction, text }) => ({ id, instruction, text }));
    return [fixture.operation, Object.freeze({
      operation: fixture.operation,
      targetId: fixture.targetId,
      instruction: fixture.instruction,
      appendLast: fixture.appendLast,
      mode: fixture.appendLast
        ? "Continue from the exact final character of the unfinished passage."
        : "Write a new passage after the complete preceding passage in response to the instruction.",
      seam: fixture.appendLast
        ? fixture.context.at(-1)!.text
        : fixture.context.at(-1)!.text,
      context: Object.freeze(context)
    }) satisfies GemmaScoringReference];
  })) as Record<GemmaReplayOperation, GemmaScoringReference>);

/** Refuse a shortened fixture before a replay sends a model request. */
export function assertGemmaFixtureContextSize(prompt: PromptPlan): void {
  const text = prompt.turns.flatMap((turn) => turn.blocks)
    .map((block) => block.kind === "source" ? block.text : "")
    .join("\n");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes < GEMMA_MINIMUM_RENDERED_CONTEXT_BYTES) {
    throw new Error(`Gemma replay fixture context must contain at least ${GEMMA_MINIMUM_RENDERED_CONTEXT_BYTES} UTF-8 bytes`);
  }
}

function node(
  id: string,
  parentId: string | null,
  instruction: string,
  text: string
): StoryNode {
  return {
    id,
    parentId,
    instruction,
    text,
    model: "gemma-4-31b",
    createdAt: "2026-08-13T00:00:00.000Z",
    activeChildId: null
  };
}
