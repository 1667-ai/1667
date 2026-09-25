/** Ported from `~/source/storytavern/web/src/icons.tsx` (full), plus `menu`
 *  (new — StoryTavern has no drawer breakpoint to open, so it never needed
 *  one). Line icons drawn at the text colour (24-unit viewBox, stroked).
 *  Most of this set is for steps 4–10 (manuscript, map, retake/edit); the
 *  Library only uses a handful of these today. */
export const ICONS = {
  menu: "M4 7h16 M4 12h16 M4 17h16",
  plus: "M12 5v14 M5 12h14",
  upload: "M12 15V3 M8 7l4-4 4 4 M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4",
  gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-2.82 1.17V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 8 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 3.6 15H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6h.09A1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 21 9v.09a2 2 0 1 1 0 4Z",
  moon: "M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z",
  droplet: "M12 2.7c3.6 4.2 6 7.3 6 10.3a6 6 0 1 1-12 0c0-3 2.4-6.1 6-10.3Z",
  sun: "M12 4V2 M12 22v-2 M4 12H2 M22 12h-2 M5.6 5.6 4.2 4.2 M19.8 19.8l-1.4-1.4 M18.4 5.6l1.4-1.4 M4.2 19.8l1.4-1.4 M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z",
  pin: "M12 17v5 M9 3h6l1 7c1.5.7 2 2 2 3H6c0-1 .5-2.3 2-3l1-7Z",
  lock: "M5 11V7a7 7 0 0 1 14 0v4 M4 11h16v10H4Z",
  pen: "M4 20h4L20 8a2.8 2.8 0 0 0-4-4L4 16v4Z",
  x: "M6 6l12 12 M18 6L6 18",
  edit: "M4 20h4L20 8a2.8 2.8 0 0 0-4-4L4 16v4Z M14 6l4 4",
  rewrite: "M12 3l1.9 4.6L18.5 9.5 13.9 11.4 12 16l-1.9-4.6L5.5 9.5l4.6-1.9L12 3Z M18 16l.9 2.1 2.1.9-2.1.9L18 22l-.9-2.1-2.1-.9 2.1-.9L18 16Z",
  penFork: "M12 21v-6 M12 15L6 9V4 M12 15l6-6V4",
  summaryTake: "M9 21v-6 M9 15L4 10V5 M9 15l5-5V5 M14 15h7 M14 18h7 M14 21h7",
  regenerate: "M20 12a8 8 0 1 1-2.6-5.9 M20 4v4h-4",
  trash: "M4 7h16 M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2 M6 7l1 13h10l1-13 M10 11v6 M14 11v6",
  left: "M15 5l-7 7 7 7",
  right: "M9 5l7 7-7 7",
  down: "M6 9l6 6 6-6",
  up: "M12 19V5 M5 12l7-7 7 7",
  play: "M8 5l11 7-11 7V5Z",
  summary: "M4 6h16 M4 12h10 M4 18h7",
  star: "M12 3l2.6 5.7 6.1.7-4.5 4.2 1.2 6.1L12 17l-5.4 2.9 1.2-6.1-4.5-4.2 6.1-.7L12 3Z",
  autoname: "M12 2l1.8 4.2L18 8l-4.2 1.8L12 14l-1.8-4.2L6 8l4.2-1.8L12 2Z M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15Z M5 14l1 2.3L8.3 17 6 18l-1 2.3L4 18l-2.3-1L4 16.3 5 14Z",
  map: "M4 5l5-2 6 2 5-2v16l-5 2-6-2-5 2V5Z M9 3v16 M15 5v16",
  dots: "M5 12h.01 M12 12h.01 M19 12h.01",
  flag: "M5 21V4 M5 5h11l-2 4 2 4H5",
  loom: "M4 4v16 M4 8h7c4 0 4-4 9-4 M11 8c4 0 4 4 9 4 M4 16h7c4 0 4-4 9-4 M11 16c4 0 4 4 9 4"
} as const;

/** The `icon` class carries the stroke contract (`svg.icon` in
 *  `styles/base.css`); contexts only override size and stroke width. */
export function Icon({ path, filled = false }: { path: string; filled?: boolean }) {
  return (
    <svg className={`icon${filled ? " icon-filled" : ""}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={path} />
    </svg>
  );
}
