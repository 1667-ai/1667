import { useEffect, useState } from "react";
import { useAppContext } from "../app/context.js";

function hasFiles(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes("Files") === true;
}

/**
 * Drop a story file anywhere on the page to import it as a new story. While a
 * file is dragged over the page, a hint shows. Text dragged inside the page
 * is not a file and is left alone.
 */
export function ImportDrop() {
  const { actions } = useAppContext();
  const [over, setOver] = useState(false);

  useEffect(() => {
    // `dragenter` and `dragleave` fire for every element the pointer crosses;
    // the depth count tells when the pointer has left the page.
    let depth = 0;
    const enter = (event: DragEvent): void => {
      if (!hasFiles(event)) return;
      depth += 1;
      setOver(true);
    };
    const leave = (event: DragEvent): void => {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setOver(false);
    };
    const dragOver = (event: DragEvent): void => {
      // Without this the browser opens the dropped file instead of dropping it.
      if (hasFiles(event)) event.preventDefault();
    };
    const drop = (event: DragEvent): void => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setOver(false);
      void actions.imports.importStories([...(event.dataTransfer?.files ?? [])]);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", dragOver);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", dragOver);
      window.removeEventListener("drop", drop);
    };
  }, [actions]);

  if (!over) return null;
  return (
    <div className="import-drop" role="status">
      <span>Drop a story file to import it</span>
      <span className="import-drop-hint">.md · .jsonl · .story · .scenario</span>
    </div>
  );
}
