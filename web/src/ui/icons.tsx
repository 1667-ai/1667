/** Ported from `~/source/storytavern/web/src/icons.tsx`, trimmed to the
 *  icons this app uses. Line icons drawn at the text colour (24-unit viewBox,
 *  stroked). `FILLED` icons are solid shapes instead (the `···` dots). */
export const ICONS = {
  menu: "M4 7h16 M4 12h16 M4 17h16",
  plus: "M12 5v14 M5 12h14",
  moon: "M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z",
  droplet: "M12 2.7c3.6 4.2 6 7.3 6 10.3a6 6 0 1 1-12 0c0-3 2.4-6.1 6-10.3Z",
  sun: "M12 4V2 M12 22v-2 M4 12H2 M22 12h-2 M5.6 5.6 4.2 4.2 M19.8 19.8l-1.4-1.4 M18.4 5.6l1.4-1.4 M4.2 19.8l1.4-1.4 M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z",
  pen: "M4 20h4L20 8a2.8 2.8 0 0 0-4-4L4 16v4Z",
  penLine: "M13 20h8 M4 20h3L18.5 8.5a2.1 2.1 0 0 0-3-3L4 17v3Z",
  squarePen: "M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6 M18.4 3.6a2 2 0 0 1 2.9 2.9L12 15.8l-3.8 1 1-3.8Z",
  x: "M6 6l12 12 M18 6L6 18",
  trash: "M4 7h16 M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2 M6 7l1 13h10l1-13 M10 11v6 M14 11v6",
  chevronLeft: "M15 6l-6 6 6 6",
  chevronRight: "M9 6l6 6-6 6",
  arrowRight: "M5 12h14 M13 6l6 6-6 6",
  rotate: "M3 12a9 9 0 1 0 2.6-6.4L3 8 M3 3v5h5",
  signpost: "M12 3v3 M12 14v7 M5 6h12l3 4-3 4H5Z",
  message: "M20 15a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2Z",
  branch: "M6 3v12 M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M18 9a9 9 0 0 1-9 9",
  /* Three solid circles, r 1.6, each drawn as two arcs (`FILLED`). */
  dots: "M3.4 12a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0-3.2 0 M10.4 12a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0-3.2 0 M17.4 12a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0-3.2 0"
} as const;

const FILLED: ReadonlySet<string> = new Set([ICONS.dots]);

/** The `icon` class carries the stroke contract (`svg.icon` in
 *  `styles/base.css`); contexts only set the size. */
export function Icon({ path }: { path: string }) {
  return (
    <svg className={FILLED.has(path) ? "icon icon-filled" : "icon"} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={path} />
    </svg>
  );
}
