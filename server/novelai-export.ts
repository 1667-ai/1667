import { Packr } from "msgpackr";
import type { StoryFact, StoryNode, StoryPayload } from "../shared/types.js";

export type NovelAiExportFormat = "story" | "scenario" | "lorebook";

export interface NovelAiArchiveExport {
  readonly extension: `.${NovelAiExportFormat}`;
  readonly text: string;
  /** Content-free account of data that the target format cannot carry. */
  readonly fidelity: readonly string[];
}

/**
 * Make a standalone NovelAI archive from one selected story line.
 * The output has no retry history or private 1667 state.
 */
export function exportNovelAiArchive(
  story: StoryPayload,
  authorBrief: string,
  format: NovelAiExportFormat
): NovelAiArchiveExport {
  const prose = selectedProse(story);
  const fidelity = exportFidelity(story, prose, format);

  switch (format) {
    case "story":
      return {
        extension: ".story",
        text: `${JSON.stringify(storyArchive(story, prose))}\n`,
        fidelity
      };
    case "scenario":
      return {
        extension: ".scenario",
        text: `${JSON.stringify(scenarioArchive(story, prose, authorBrief))}\n`,
        fidelity
      };
    case "lorebook":
      return {
        extension: ".lorebook",
        text: `${JSON.stringify(lorebookArchive(story.facts))}\n`,
        fidelity
      };
  }
}

function selectedProse(story: StoryPayload): StoryNode[] {
  return story.path.filter((part) => part.role !== "summary");
}

function storyArchive(story: StoryPayload, prose: readonly StoryNode[]): Record<string, unknown> {
  const sections = new Map<number, MessagePackValue>();
  const order: number[] = [];
  for (const [index, part] of prose.entries()) {
    const sectionId = index + 1;
    order.push(sectionId);
    sections.set(sectionId, {
      type: 1,
      text: part.text,
      // Keep the producer fields that existing Editor V2 archives use.
      meta: new Map(),
      source: undefined,
      // Keep the current Document API fields explicit for neutral prose.
      origin: [],
      formatting: []
    });
  }
  const document = new NovelAiDocument({
    sections,
    order,
    // Empty, explicit producer shape. We never encode undo or retry history.
    history: new NovelAiHistory({ root: 0, current: 0, nodes: [] }),
    dirtySections: new Map<string, MessagePackValue>(),
    step: 1
  });
  return {
    storyContainerVersion: 1,
    metadata: {
      storyMetadataVersion: 1,
      id: story.id,
      title: story.title,
      description: "",
      textPreview: "",
      isTA: false,
      favorite: false,
      tags: [],
      createdAt: timestamp(story.createdAt),
      lastUpdatedAt: timestamp(story.updatedAt),
      isModified: false,
      hasDocument: true
    },
    content: {
      storyContentVersion: 6,
      settings: {},
      document: encodeNovelAiDocument(document).toString("base64"),
      context: [],
      lorebook: lorebookArchive([]),
      storyContextConfig: storyContextConfig(),
      ephemeralContext: [],
      contextDefaults: {
        ephemeralDefaults: [],
        loreDefaults: []
      },
      settingsDirty: false,
      phraseBiasGroups: [],
      bannedSequenceGroups: [],
      messageSettings: {},
      sideChats: [],
      userScripts: [],
      scriptStorage: {}
    }
  };
}

function scenarioArchive(
  story: StoryPayload,
  prose: readonly StoryNode[],
  authorBrief: string
): Record<string, unknown> {
  return {
    scenarioVersion: 3,
    title: story.title,
    description: "",
    prompt: prose.map((part) => part.text).join("\n\n"),
    tags: [],
    context: [
      scenarioContext("", 800, 0, 0),
      scenarioContext(authorBrief, -400, 1, -4)
    ],
    ephemeralContext: [],
    placeholders: [],
    lorebook: lorebookArchive(story.facts),
    author: "",
    storyContextConfig: storyContextConfig(),
    settings: {},
    contextDefaults: {
      ephemeralDefaults: [],
      loreDefaults: []
    },
    phraseBiasGroups: [],
    bannedSequenceGroups: [],
    messageSettings: {},
    userScripts: []
  };
}

function storyContextConfig(): Record<string, unknown> {
  return {
    prefix: "",
    suffix: "",
    tokenBudget: 1,
    reservedTokens: 512,
    budgetPriority: 0,
    trimDirection: "trimTop",
    insertionType: "newline",
    maximumTrimType: "sentence",
    insertionPosition: -1,
    allowInsertionInside: true
  };
}

function scenarioContext(
  text: string,
  budgetPriority: number,
  reservedTokens: number,
  insertionPosition: number
): Record<string, unknown> {
  return {
    text,
    contextConfig: {
      prefix: "",
      suffix: "\n",
      tokenBudget: 1,
      reservedTokens,
      budgetPriority,
      trimDirection: "trimBottom",
      insertionType: "newline",
      maximumTrimType: "sentence",
      insertionPosition
    }
  };
}

function lorebookArchive(facts: readonly StoryFact[]): Record<string, unknown> {
  const categories = categoriesForFacts(facts);
  const categoryIds = new Map(categories.map((category) => [category.name, category.id]));
  return {
    lorebookVersion: 6,
    entries: facts.map((fact) => lorebookEntry(fact, categoryIds.get(fact.tag ?? "") ?? "")),
    settings: { orderByKeyLocations: false },
    categories,
    order: []
  };
}

interface LorebookCategory {
  readonly name: string;
  readonly id: string;
  readonly enabled: true;
  readonly createSubcontext: false;
  readonly settings: Record<string, never>;
  readonly order: readonly [];
  readonly open: true;
}

function categoriesForFacts(facts: readonly StoryFact[]): LorebookCategory[] {
  const categories = new Map<string, LorebookCategory>();
  for (const fact of facts) {
    if (fact.tag === null || fact.tag === "" || categories.has(fact.tag)) continue;
    categories.set(fact.tag, {
      name: fact.tag,
      id: `category:${fact.tag}`,
      enabled: true,
      createSubcontext: false,
      settings: {},
      order: [],
      open: true
    });
  }
  return [...categories.values()];
}

function lorebookEntry(fact: StoryFact, category: string): Record<string, unknown> {
  return {
    text: fact.text,
    contextConfig: {
      prefix: "",
      suffix: "\n",
      tokenBudget: 1,
      reservedTokens: 0,
      budgetPriority: 400,
      trimDirection: "trimBottom",
      insertionType: "newline",
      maximumTrimType: "sentence",
      insertionPosition: -1
    },
    lastUpdatedAt: timestamp(fact.updatedAt),
    displayName: fact.tag ?? "",
    id: fact.id,
    keys: [...fact.keys],
    searchRange: 1000,
    enabled: true,
    forceActivation: fact.activation === "always",
    keyRelative: false,
    nonStoryActivatable: false,
    category,
    loreBiasGroups: [],
    advancedConditions: []
  };
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function exportFidelity(
  story: StoryPayload,
  prose: readonly StoryNode[],
  format: NovelAiExportFormat
): readonly string[] {
  const selectedIds = new Set(prose.map((part) => part.id));
  const alternateTakes = story.nodes.filter(
    (part) => part.role !== "summary" && !selectedIds.has(part.id)
  ).length;
  const directions = story.nodes.filter(
    (part) => part.role !== "summary" && part.hasInstruction
  ).length;
  const summaries = story.nodes.filter((part) => part.role === "summary").length;
  const authorsNotes = story.authorsNote === undefined ? 0 : 1;
  const omissions = [
    `${alternateTakes} alternate ${countNoun(alternateTakes, "take")} omitted.`,
    `${story.tags.length} story line ${countNoun(story.tags.length, "tag")} omitted.`,
    `${directions} ${countNoun(directions, "direction")} omitted.`,
    `${summaries} summary ${countNoun(summaries, "part")} omitted.`,
    `${story.chapterBreaks.length} chapter ${countNoun(story.chapterBreaks.length, "break")} omitted.`,
    `${authorsNotes} ${countNoun(authorsNotes, "Author's Note")} omitted.`,
    "NovelAI history omitted."
  ];
  switch (format) {
    case "story":
      return [
        `${prose.length} active prose ${countNoun(prose.length, "part")} selected.`,
        `${story.facts.length} ${countNoun(story.facts.length, "fact")} omitted.`,
        ...omissions
      ];
    case "scenario":
      return [
        `${prose.length} active prose ${countNoun(prose.length, "part")} flattened into one prompt.`,
        `${story.facts.length} ${countNoun(story.facts.length, "fact")} exported in the lorebook.`,
        ...omissions
      ];
    case "lorebook":
      return [
        `${story.facts.length} ${countNoun(story.facts.length, "fact")} exported with activation modes and keys.`,
        `${prose.length} active prose ${countNoun(prose.length, "part")} omitted from the lorebook.`,
        ...omissions
      ];
  }
}

function countNoun(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

type MessagePackRecord = { readonly [key: string]: MessagePackValue };
type MessagePackValue =
  | undefined
  | string
  | number
  | boolean
  | null
  | MessagePackRecord
  | readonly MessagePackValue[]
  | ReadonlyMap<string | number, MessagePackValue>
  | NovelAiHistory;

class NovelAiDocument {
  constructor(readonly value: MessagePackRecord) {}
}

class NovelAiHistory {
  constructor(readonly value: MessagePackRecord) {}
}

const scalarPackr = new Packr({
  bundleStrings: false,
  mapsAsObjects: false,
  moreTypes: false,
  structuredClone: false,
  useRecords: false
});

function encodeNovelAiDocument(document: NovelAiDocument): Buffer {
  return new NovelAiMessagePackEncoder().encode(document);
}

class NovelAiMessagePackEncoder {
  private readonly records = new Map<string, number>();

  encode(value: NovelAiDocument | MessagePackValue): Buffer {
    if (value instanceof NovelAiDocument) return this.extension(20, value.value);
    if (value instanceof NovelAiHistory) return this.extension(30, value.value);
    if (Array.isArray(value)) return container(value.length, false, value.map((item) => this.encode(item)));
    if (value instanceof Map) {
      const entries: Buffer[] = [];
      for (const [key, entry] of value) entries.push(this.encode(key), this.encode(entry));
      return container(value.size, true, entries);
    }
    if (isMessagePackRecord(value)) return this.record(value);
    if (value === undefined || value === null || typeof value === "string"
      || typeof value === "number" || typeof value === "boolean") {
      return Buffer.from(scalarPackr.pack(value));
    }
    throw new Error("Unsupported NovelAI MessagePack value");
  }

  private extension(type: number, value: MessagePackRecord): Buffer {
    return Buffer.concat([Buffer.from([0xd4, type, 0]), this.encode(value)]);
  }

  private record(value: MessagePackRecord): Buffer {
    const entries = Object.entries(value) as Array<[string, MessagePackValue]>;
    const shape = JSON.stringify(entries.map(([key]) => key));
    let id = this.records.get(shape);
    const encoded: Buffer[] = [];
    if (id === undefined) {
      id = this.records.size;
      if (id >= 32) throw new Error("NovelAI document has too many record shapes");
      this.records.set(shape, id);
      encoded.push(Buffer.from([0xd4, 0x72, 0x40 + id]), this.encode(entries.map(([key]) => key)));
    } else {
      encoded.push(Buffer.from([0x40 + id]));
    }
    for (const [, entry] of entries) encoded.push(this.encode(entry));
    return Buffer.concat(encoded);
  }
}

function isMessagePackRecord(value: NovelAiDocument | MessagePackValue): value is MessagePackRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Map);
}

function container(size: number, map: boolean, values: readonly Buffer[]): Buffer {
  if (size < 16) return Buffer.concat([Buffer.from([(map ? 0x80 : 0x90) | size]), ...values]);
  if (size <= 0xffff) {
    return Buffer.concat([Buffer.from([map ? 0xde : 0xdc, size >> 8, size & 0xff]), ...values]);
  }
  const header = Buffer.allocUnsafe(5);
  header[0] = map ? 0xdf : 0xdd;
  header.writeUInt32BE(size, 1);
  return Buffer.concat([header, ...values]);
}
