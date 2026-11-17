import { Fragment, useLayoutEffect, useMemo, useRef, type MouseEvent, type ReactNode, type RefObject } from "react";
import { splitWords } from "./words.js";

/** Space between the last shown word and the knob. */
const KNOB_GAP_PX = 6;

/** Puts the knob after word `shown` of the paragraph, or at its start when no word shows. */
function placeKnob(paragraph: HTMLElement, knob: HTMLElement, shown: number): void {
  const wrap = paragraph.parentElement;
  if (wrap === null) return;
  const origin = wrap.getBoundingClientRect();
  const words = paragraph.querySelectorAll<HTMLElement>("[data-word]");
  const word = words[shown === 0 ? 0 : shown - 1];
  let x: number;
  let centerY: number;
  if (word === undefined) {
    const box = paragraph.getBoundingClientRect();
    x = box.left - origin.left;
    centerY = box.top - origin.top + parseFloat(getComputedStyle(paragraph).lineHeight) / 2;
  } else {
    const box = word.getBoundingClientRect();
    x = (shown === 0 ? box.left : box.right + KNOB_GAP_PX) - origin.left;
    centerY = box.top + box.height / 2 - origin.top;
  }
  knob.style.left = `${x}px`;
  knob.style.top = `${centerY - knob.offsetHeight / 2}px`;
}

/**
 * The preview text, one span per word. Words past the knob stay in the layout
 * but are hidden, so nothing moves when the knob does. The knob is one
 * element outside the text, put after the last shown word.
 */
export function ContinuationText(
  { text, shown, knob, knobRef, textRef, onPickWord }: {
    readonly text: string;
    readonly shown: number;
    readonly knob: ReactNode;
    readonly knobRef: RefObject<HTMLElement | null>;
    readonly textRef: RefObject<HTMLParagraphElement | null>;
    readonly onPickWord: (count: number) => void;
  }
) {
  const { words } = useMemo(() => splitWords(text), [text]);
  const moved = useRef(-1);
  useLayoutEffect(() => {
    const paragraph = textRef.current;
    const element = knobRef.current;
    if (paragraph === null || element === null) return;
    const place = (): void => placeKnob(paragraph, element, shown);
    place();
    if (moved.current !== shown) {
      moved.current = shown;
      element.scrollIntoView({ block: "nearest" });
    }
    const observer = new ResizeObserver(place);
    observer.observe(paragraph);
    return () => observer.disconnect();
  }, [text, shown, textRef, knobRef]);
  const onClick = (event: MouseEvent<HTMLElement>): void => {
    const word = (event.target as HTMLElement).closest<HTMLElement>("[data-word]");
    if (word !== null) onPickWord(Number(word.dataset.word) + 1);
  };
  return (
    <div className="steer-text-wrap">
      <p ref={textRef} className="steer-continuation" aria-label="Continuation" onClick={onClick}>
        {words.map((word, index) => (
          <Fragment key={index}>
            <span data-word={index} className={index < shown ? "steer-word" : "steer-word steer-word-ahead"}>{word.text}</span>
            {word.gap}
          </Fragment>
        ))}
      </p>
      {knob}
    </div>
  );
}
