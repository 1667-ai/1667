import type { Bookmark, Story, StoryNode } from "../../shared/types.js";
import { demoChapterSummaryNode } from "./demo-chapters.js";

export const DEMO_CREATED_AT = "1667-07-19T16:07:00.000Z";
export const DEMO_EDITED_AT = "1667-07-19T16:08:00.000Z";

const MAIN_TEXT = [
  "Maren lit the last lamp before the storm found Sorrow Cliff.",
  "Below the lantern-house, the inn windows burned amber against the rain.",
  "At the final bell a traveler arrived without a horse and asked for shelter.",
  "His coat held no water, though the road behind him had become a river.",
  "Maren saw the brass compass at his belt and looked away before he noticed.",
  "The guests made room in the silence people reserve for dangerous strangers.",
  "He called himself Ashe, paid for three nights, and never once asked the price.",
  "The coins were cold enough to mist the bar beneath Maren's hand.",
  "Upstairs, one of the five lanterns went dark without spending its oil.",
  "Maren keeps the last lit lantern-house on the Sorrow Cliff road. A three-day storm has closed the pass; the inn below is full of stranded travelers. One guest, calling himself Ashe, paid for oil he never burns and carries a compass that points at want, not north.",
  "Maren counted the lanterns twice before answering. Four lit, one dark, and the dark one was the traveler's — though he had paid for oil like everyone else, and paid in coin so old the mint had no name for it. 'You'll want the corner room,' she said. 'It keeps its heat, and it keeps its opinions to itself.'",
  "He did not move toward the stairs. Instead he set the brass compass on the bar between them, and its needle went around twice, slow, like a dog deciding whether to lie down, and stopped pointing at Maren. 'Has the cliff road ever been walked at night without a light?' he asked. 'Not by anyone who came back,' she said. The needle shivered and held.",
  "Outside, the storm leaned on the shutters like a patient animal. Maren wiped the same glass she had already wiped, watching the"
] as const;

const INSTRUCTIONS = [
  "open on the last light before the storm",
  "show the inn below",
  "a knock after the last bell",
  "make the traveler uncanny but polite",
  "maren recognizes something dangerous",
  "the room notices him",
  "name the traveler",
  "make his money feel wrong",
  "one lantern fails",
  "summarize the story so far",
  "make the traveler's money feel wrong",
  "the compass does something that unsettles maren",
  ""
] as const;

export function demoFacts(): Story["facts"] {
  const rows: Array<[string, string]> = [
    ["people", "Maren\nKeeps the lantern-house and distrusts old coin."],
    ["people", "Ashe\nCarries a brass compass that points at want."],
    ["places", "Sorrow Cliff\nRoad is closed by a three-day storm."],
    ["rules", "Night road\nNo traveler walks the cliff road at night without a light and returns."],
    ["items", "Five lanterns\nCorrespond to the inn's occupied rooms."]
  ];
  return rows.map(([tag, text], index) => ({
    id: `fact-${index + 1}`,
    tag,
    text,
    createdAt: DEMO_CREATED_AT,
    updatedAt: DEMO_CREATED_AT
  }));
}

export function demoBookmarks(): Bookmark[] {
  return [
    { nodeId: "p13", name: "canon-storm", label: "Canon", color: "#E3B341", createdAt: DEMO_CREATED_AT },
    { nodeId: "p11-alt", name: "alt-quiet-inn", label: "Alt", color: "#C49AC4", createdAt: DEMO_CREATED_AT },
    { nodeId: "p5-alt", name: "draft-ledger", label: "Draft", color: "#9FB6C4", createdAt: DEMO_CREATED_AT },
    { nodeId: "p8-alt-3", name: "burned", label: "Discarded", color: "#7A7166", createdAt: DEMO_CREATED_AT }
  ];
}

export function buildDemoNodes(dense: boolean): StoryNode[] {
  const nodes: StoryNode[] = [];
  for (let number = 1; number <= 11; number += 1) {
    const id = `p${number}`;
    nodes.push(makeDemoNode(
      id,
      number === 1 ? null : `p${number - 1}`,
      INSTRUCTIONS[number - 1]!,
      MAIN_TEXT[number - 1]!
    ));
    if (number > 1) nodes.find((node) => node.id === `p${number - 1}`)!.activeChildId = id;
  }

  nodes.push(makeDemoNode("p11-alt", "p10", "let the traveler choose no room", "Ashe stayed beside the cold hearth and asked Maren who had taught the lanterns to fear the dark."));
  const takeCount = dense ? 20 : 5;
  const activeTake = dense ? 12 : 3;
  for (let take = 1; take <= takeCount; take += 1) {
    const id = take === activeTake ? "p12" : `p12-t${take}`;
    const node = makeDemoNode(
      id,
      "p11",
      INSTRUCTIONS[11],
      take === activeTake ? MAIN_TEXT[11] : alternativeCompassText(take)
    );
    if (take === activeTake) {
      const phrase = "like a dog deciding whether to lie down,";
      const start = node.text.indexOf(phrase);
      node.attribution = { source: "human", ranges: [{ start, end: start + phrase.length }] };
    }
    nodes.push(node);
  }
  nodes.find((node) => node.id === "p11")!.activeChildId = "p12";
  const p13 = makeDemoNode("p13", "p12", INSTRUCTIONS[12], MAIN_TEXT[12]);
  p13.updatedAt = "2022-10-25T09:00:00.000Z";
  nodes.push(p13);
  nodes.find((node) => node.id === "p12")!.activeChildId = "p13";

  nodes.push(makeDemoNode("p3-alt", "p2", "the knock comes from inside", "The third knock came from the locked pantry, soft as a fingernail on glass."));
  nodes.push(makeDemoNode("p5-alt", "p4", "maren refuses the stranger", "Maren barred the door. The traveler smiled as though she had opened it wider."));
  nodes.push(makeDemoNode("p8-alt-1", "p7", "the coins are ordinary", "The coins were newly minted and warm from his palm."));
  nodes.push(makeDemoNode("p8-alt-2", "p7", "the ledger rejects the payment", "Every time Maren wrote the sum, the ink climbed back into her pen."));
  nodes.push(makeDemoNode("p8-alt-3", "p7", "burn the old coin", "She dropped one coin into the fire. The flame bowed away from it."));
  nodes.find((node) => node.id === "p5-alt")!.updatedAt = "2022-09-01T09:00:00.000Z";
  for (const id of ["p11-alt", "p8-alt-3"]) {
    nodes.find((node) => node.id === id)!.updatedAt = "2022-10-25T09:00:00.000Z";
  }
  nodes.push(demoChapterSummaryNode(DEMO_CREATED_AT));
  return nodes;
}

export function makeDemoNode(
  id: string,
  parentId: string | null,
  instruction: string,
  text: string,
  extra: Partial<StoryNode> | undefined = undefined
): StoryNode {
  return {
    id,
    parentId,
    instruction,
    text,
    model: "qwen3-32b",
    createdAt: DEMO_CREATED_AT,
    activeChildId: null,
    ...extra
  };
}

function alternativeCompassText(take: number): string {
  const variants = [
    "Ashe left the compass closed and asked whether Maren believed a road could remember every traveler it lost.",
    "The compass needle pointed through the floorboards, toward something beneath the inn that answered with one careful knock.",
    "He set the brass compass between them. Its needle circled twice, then stopped on Maren as if it had found north.",
    "The compass opened by itself. In place of directions, its face bore five tiny flames; one went dark while Maren watched.",
    "Ashe offered her the compass without touching it, and the needle followed the hand she kept hidden beneath the bar."
  ];
  return variants[(take - 1) % variants.length]!;
}
