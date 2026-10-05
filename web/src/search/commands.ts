import { searchAvailable } from "./available.js";
import { registerCommands } from "../palette/registry.js";

registerCommands([
  {
    id: "search",
    title: "search",
    description: "search this story or the whole vault",
    section: "view",
    shortcut: "/",
    available: ({ state }) => searchAvailable(state),
    run: ({ actions }) => actions.overlay.open("search")
  }
]);
