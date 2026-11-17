import type { CSSProperties, KeyboardEvent, PointerEventHandler, RefObject } from "react";

export const KNOB_LABEL = "Continuation knob";
const WORDS_PER_BIG_STEP = 10;

/** The keys that move the knob, as a new word count, or `null` for any other key. */
function keyTarget(key: string, shift: boolean, shown: number, generated: number): number | null {
  const step = shift ? WORDS_PER_BIG_STEP : 1;
  if (key === "ArrowLeft") return shown - step;
  if (key === "ArrowRight") return shown + step;
  if (key === "Home") return 0;
  if (key === "End") return generated;
  return null;
}

interface KnobProps {
  readonly knobRef: RefObject<HTMLButtonElement | null>;
  readonly shown: number;
  readonly generated: number;
  /** How full the buffer of words ahead is, from 0 to 1. */
  readonly buffer: number;
  readonly generating: boolean;
  readonly dragging: boolean;
  readonly onMove: (count: number) => void;
  readonly pointer: {
    readonly onPointerDown: PointerEventHandler<HTMLElement>;
    readonly onPointerMove: PointerEventHandler<HTMLElement>;
    readonly onPointerUp: PointerEventHandler<HTMLElement>;
    readonly onPointerCancel: PointerEventHandler<HTMLElement>;
  };
}

/**
 * The main knob: a slider over the generated words. The ring shows how much
 * text is ready ahead of it, and an arc turns while a request streams.
 */
export function Knob({ knobRef, shown, generated, buffer, generating, dragging, onMove, pointer }: KnobProps) {
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const target = keyTarget(event.key, event.shiftKey, shown, generated);
    if (target === null) return;
    event.preventDefault();
    onMove(target);
  };
  return (
    <button
      ref={knobRef}
      type="button"
      role="slider"
      className="steer-knob"
      aria-label={KNOB_LABEL}
      aria-valuemin={0}
      aria-valuemax={generated}
      aria-valuenow={shown}
      aria-valuetext={`${shown} of ${generated} words`}
      title="Scrub the continuation (←/→, Home, End)"
      data-generating={generating ? "" : undefined}
      data-dragging={dragging ? "" : undefined}
      style={{ "--buffer": buffer } as CSSProperties}
      onKeyDown={onKeyDown}
      {...pointer}
    />
  );
}
