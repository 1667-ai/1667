import { expect, test } from "bun:test";
import { segment, type FrameLine } from "../src/screens/story/frame.js";
import { viewportLines, type ViewportBlock } from "../src/screens/story/viewport.js";
import {
  followStoryViewport,
  pinStoryViewport,
  scrollStoryViewport
} from "../src/viewport-intent.js";

function block(index: number, height: number, rendered: number[]): ViewportBlock {
  return {
    partId: `part-${index}`,
    partIndex: index,
    height,
    render(): FrameLine[] {
      rendered.push(index);
      return Array.from({ length: height }, (_, line) => [segment(`${index}:${line}`)]);
    }
  };
}

test("viewport renders only visible blocks", () => {
  const rendered: number[] = [];
  const blocks = Array.from({ length: 100 }, (_, index) => block(index, 10, rendered));
  const viewport = viewportLines(blocks, "part-99", 20, false, null);

  expect(rendered).toEqual([98, 99]);
  expect(viewport.lines).toHaveLength(20);
  expect(viewport.owners).toEqual([...Array(10).fill(98), ...Array(10).fill(99)]);
  expect(viewport.blockRows).toEqual([...Array(10).keys(), ...Array(10).keys()]);
  expect(viewport.start).toBe(980);
});

test("viewport slices partially visible blocks and preserves owners", () => {
  const rendered: number[] = [];
  const blocks = [block(0, 10, rendered), block(1, 10, rendered), block(2, 10, rendered)];
  const viewport = viewportLines(blocks, null, 10, false, 15);

  expect(rendered).toEqual([1, 2]);
  expect(viewport.lines.map((line) => line[0]?.text)).toEqual([
    "1:5", "1:6", "1:7", "1:8", "1:9", "2:0", "2:1", "2:2", "2:3", "2:4"
  ]);
  expect(viewport.owners).toEqual([...Array(5).fill(1), ...Array(5).fill(2)]);
  expect(viewport.blockRows).toEqual([5, 6, 7, 8, 9, 0, 1, 2, 3, 4]);
});

test("cold-frame scroll intent stays relative until a complete viewport exists", () => {
  const intent = { viewScroll: null, viewScrollDelta: 0 };
  scrollStoryViewport(intent, -3);
  const viewport = viewportLines(
    Array.from({ length: 10 }, (_, index) => block(index, 10, [])),
    "part-9",
    20,
    false,
    intent.viewScroll,
    intent.viewScrollDelta
  );

  expect(intent).toEqual({ viewScroll: null, viewScrollDelta: -3 });
  expect(viewport).toMatchObject({ start: 77, viewScroll: 77 });
  followStoryViewport(intent);
  expect(intent).toEqual({ viewScroll: null, viewScrollDelta: 0 });
  pinStoryViewport(intent, 12);
  scrollStoryViewport(intent, -2);
  expect(intent).toEqual({ viewScroll: 10, viewScrollDelta: 0 });
});

test("viewport rejects drift between measured and rendered block heights", () => {
  const blocks: ViewportBlock[] = [{
    partId: "drifting-part",
    partIndex: 0,
    height: 2,
    render: () => [[segment("only one row")]]
  }];

  expect(() => viewportLines(blocks, "drifting-part", 2, false, null))
    .toThrow("viewport block drifting-part measured 2 rows but rendered 1");
});
