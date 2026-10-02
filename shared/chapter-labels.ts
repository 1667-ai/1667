import type { StoryChapter } from "./manuscript-model.js";

/** What a chapter is called on screen.
 *
 * Chapter one is opened by no break, so before it is named it has no title of
 * its own and reads as the story — which is exactly what the export does, where
 * an unnamed chapter one takes no heading because the document title already
 * names it. Calling it "(untitled)" said the opposite of that. */
export function chapterDisplayTitle(chapter: StoryChapter, storyTitle: string): string {
  if (chapter.title !== "") return chapter.title;
  return chapter.number === 1 && storyTitle !== "" ? storyTitle : "(untitled)";
}

export function extentLabel(chapter: StoryChapter): string {
  if (chapter.startPart === null || chapter.endPart === null) return "opens next";
  return chapter.startPart === chapter.endPart
    ? `part ${chapter.startPart}`
    : `parts ${chapter.startPart}–${chapter.endPart}`;
}

export function chapterWord(number: number): string {
  const small = [
    "Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
    "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"
  ];
  if (number < small.length) return small[number]!;
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  if (number < 100) return `${tens[Math.floor(number / 10)]}${number % 10 === 0 ? "" : `-${small[number % 10]!.toLowerCase()}`}`;
  return number.toLocaleString("en-US");
}
