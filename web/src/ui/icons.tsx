/** Ported from `~/source/storytavern/web/src/icons.tsx`, trimmed to the
 *  handful the Library actually uses (review fix E — dead code from the
 *  StoryTavern port); later steps add their own icons here as they need
 *  them. Line icons drawn at the text colour (24-unit viewBox, stroked). */
export const ICONS = {
  menu: "M4 7h16 M4 12h16 M4 17h16",
  plus: "M12 5v14 M5 12h14",
  moon: "M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z",
  droplet: "M12 2.7c3.6 4.2 6 7.3 6 10.3a6 6 0 1 1-12 0c0-3 2.4-6.1 6-10.3Z",
  sun: "M12 4V2 M12 22v-2 M4 12H2 M22 12h-2 M5.6 5.6 4.2 4.2 M19.8 19.8l-1.4-1.4 M18.4 5.6l1.4-1.4 M4.2 19.8l1.4-1.4 M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z",
  pen: "M4 20h4L20 8a2.8 2.8 0 0 0-4-4L4 16v4Z",
  x: "M6 6l12 12 M18 6L6 18",
  trash: "M4 7h16 M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2 M6 7l1 13h10l1-13 M10 11v6 M14 11v6",
  dots: "M5 12h.01 M12 12h.01 M19 12h.01"
} as const;

/** The `icon` class carries the stroke contract (`svg.icon` in
 *  `styles/base.css`); contexts only override size and stroke width. */
export function Icon({ path }: { path: string }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={path} />
    </svg>
  );
}
