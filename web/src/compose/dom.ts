/**
 * Puts the keyboard in the composer's box, caret at the end. A plain DOM
 * helper, not store state: focus is not something a component should have to
 * observe. The box is found by its class. Focus moves at once, so a key
 * pressed right after is typed into the box; the caret moves one task later,
 * when a state change made just before the call (a retake filling the box) has
 * been drawn. Does nothing where there is no page (the integration tests).
 */
export function focusComposer(): void {
  if (typeof document === "undefined") return;
  const field = document.querySelector<HTMLTextAreaElement>(".composer-field");
  if (field === null) return;
  field.focus();
  setTimeout(() => field.setSelectionRange(field.value.length, field.value.length), 0);
}
