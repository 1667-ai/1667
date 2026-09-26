import { Icon, ICONS } from "../ui/icons.js";
import { usePopover } from "../ui/usePopover.js";
import { useResolvedTheme } from "./resolvedTheme.js";
import { PALETTES, type ThemeMode } from "./themes.js";

/**
 * Moved out of `library/Sidebar.tsx` (review fix B6): the palette popover
 * and the light/dark toggle in the brand bar. `useResolvedTheme`
 * (`theme/resolvedTheme.ts`) keeps the toggle icon and the picker's swatch
 * preview live when `theme === null` ("follow the OS") and the OS scheme
 * flips while the page is open (review fix C10).
 */
export function ThemeControls(
  { theme, palette, onToggleTheme, onSelectPalette }: {
    readonly theme: ThemeMode | null;
    readonly palette: string;
    readonly onToggleTheme: () => void;
    readonly onSelectPalette: (paletteId: string) => void;
  }
) {
  const resolved = useResolvedTheme(theme);
  const { open, setOpen, containerRef } = usePopover();

  return (
    <>
      <div className="theme-pick-wrap" ref={containerRef}>
        <button
          className="theme-toggle theme-pick"
          type="button"
          title="Choose theme"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <Icon path={ICONS.droplet} />
        </button>
        {open && (
          <ThemePicker
            mode={resolved}
            palette={palette}
            onSelectPalette={(paletteId) => {
              onSelectPalette(paletteId);
              setOpen(false);
            }}
          />
        )}
      </div>
      <button className="theme-toggle" type="button" title="Toggle light / dark" onClick={onToggleTheme}>
        <Icon path={resolved === "dark" ? ICONS.sun : ICONS.moon} />
      </button>
    </>
  );
}

function ThemePicker(
  { mode, palette, onSelectPalette }: {
    readonly mode: ThemeMode;
    readonly palette: string;
    readonly onSelectPalette: (paletteId: string) => void;
  }
) {
  return (
    <div className="theme-popover" role="menu" aria-label="Theme">
      <div className="theme-popover-label">Palette</div>
      {PALETTES.map((candidate) => {
        const dots = candidate.dots[mode];
        return (
          <button
            key={candidate.id}
            type="button"
            role="menuitemradio"
            aria-checked={candidate.id === palette}
            className={`theme-row${candidate.id === palette ? " active" : ""}`}
            onClick={() => onSelectPalette(candidate.id)}
          >
            <span className="theme-dots">
              <span className="theme-dot" style={{ background: dots.bg, borderColor: dots.line }} />
              <span className="theme-dot theme-dot-overlap" style={{ background: dots.accent }} />
              <span className="theme-dot theme-dot-overlap" style={{ background: dots.ink }} />
            </span>
            <span className="theme-row-text">
              <span className="theme-row-name">{candidate.name}</span>
              <span className="theme-row-tagline">{candidate.tagline}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
