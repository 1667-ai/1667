export type TakeDensity = "spaced" | "condensed" | "gauge";

export interface TakeStrip {
  density: TakeDensity;
  text: string;
  currentOffset: number;
  counter: string;
}

export function takeStrip(index: number, count: number): TakeStrip {
  if (!Number.isInteger(index) || !Number.isInteger(count) || count < 1 || index < 1 || index > count) {
    throw new Error("Take index must be within the sibling count.");
  }
  const counter = `‹ take ${index}/${count} ›`;
  if (count <= 6) {
    const cells = Array.from({ length: count }, (_, offset) => offset === index - 1 ? "●" : "○");
    return { density: "spaced", text: cells.join(" "), currentOffset: (index - 1) * 2, counter };
  }
  if (count <= 12) {
    const text = Array.from({ length: count }, (_, offset) => offset === index - 1 ? "●" : "○").join("");
    return { density: "condensed", text, currentOffset: index - 1, counter };
  }
  const currentOffset = Math.floor(((index - 1) / (count - 1)) * 13);
  return {
    density: "gauge",
    text: `${"─".repeat(currentOffset)}●${"─".repeat(13 - currentOffset)}`,
    currentOffset,
    counter
  };
}
