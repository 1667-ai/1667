import { Packr, addExtension } from "msgpackr";

/** Synthetic fixture encoded with NovelAI's exact msgpackr extension 20 form. */
export const STATIC_SYNTHETIC_V2_BASE64 =
  "1BQA1HJAldZiAAAANsEIwQXBB8ENwQSCzGXUckGSwQTBBAHBGsxmQQHBGpLMZcxm1HJCk8EEwQfBBQAAkIABoNlxc2VjdGlvbnNvcmRlcmhpc3RvcnlkaXJ0eVNlY3Rpb25zc3RlcHR5cGV0ZXh0U3ludGhldGljIGNoYXB0ZXIgMSBwcm9zZS5TeW50aGV0aWMgY2hhcHRlciAyIHByb3NlLnJvb3RjdXJyZW50bm9kZXM=";

class SyntheticNovelAiDocument {
  constructor(readonly value: Record<string, unknown>) {}
}

class SyntheticNovelAiHistory {
  constructor(readonly value: Record<string, unknown>) {}
}

export class SyntheticNovelAiSectionDiff {
  constructor(readonly value: unknown) {}
}

export class SyntheticNovelAiTextDiff {
  constructor(readonly value: Record<string, unknown>) {}
}

addExtension({
  Class: SyntheticNovelAiDocument,
  type: 20,
  write(document: SyntheticNovelAiDocument) {
    return document.value;
  },
  read(data: unknown) {
    return data;
  }
});

addExtension({
  Class: SyntheticNovelAiHistory,
  type: 30,
  write(history: SyntheticNovelAiHistory) {
    return history.value;
  },
  read(data: unknown) {
    return data;
  }
});

addExtension({
  Class: SyntheticNovelAiSectionDiff,
  type: 40,
  write(diff: SyntheticNovelAiSectionDiff) {
    return diff.value;
  },
  read(data: unknown) {
    return { diff: data };
  }
});

addExtension({
  Class: SyntheticNovelAiTextDiff,
  type: 41,
  write(diff: SyntheticNovelAiTextDiff) {
    return diff.value;
  },
  read(data: unknown) {
    return data;
  }
});

export function makeSyntheticNovelAiV2Base64(
  sections: Map<string | number, unknown> | Record<string, unknown>,
  order: (string | number)[],
  dirtySections?: Map<string | number, unknown> | Record<string, unknown>
): string {
  const packr = new Packr({
    bundleStrings: true,
    moreTypes: true,
    structuredClone: false
  });
  return packr.pack(new SyntheticNovelAiDocument({
    sections,
    order,
    history: new SyntheticNovelAiHistory({ root: 0, current: 0, nodes: [] }),
    dirtySections: dirtySections ?? new Map(),
    step: 1
  })).toString("base64");
}
