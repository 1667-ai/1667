import { registerCommands, type PaletteCommand } from "../palette/registry.js";
import { PALETTES } from "./themes.js";

registerCommands([
  ...PALETTES.map((palette): PaletteCommand => ({
    id: `theme:${palette.id}`,
    title: `theme: ${palette.id}`,
    description: `switch the palette · ${palette.tagline}`,
    section: "system",
    run: (context) => context.actions.theme.selectPalette(palette.id)
  })),
  {
    id: "toggle-theme",
    title: "theme: light or dark",
    description: "switch between the light and dark face",
    section: "system",
    run: (context) => context.actions.theme.toggleTheme()
  }
]);
