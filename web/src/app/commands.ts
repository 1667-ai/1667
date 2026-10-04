import { registerCommands } from "../palette/registry.js";

registerCommands([
  {
    id: "reconnect",
    title: "reconnect",
    description: "reload this story and its library",
    section: "system",
    available: ({ state }) => state.connection.kind === "closed",
    run: (context) => context.actions.reconnect()
  },
  {
    id: "keys",
    title: "keys",
    description: "the keys this page answers to",
    section: "system",
    shortcut: "?",
    run: (context) => context.actions.overlay.open("keys")
  },
  {
    id: "log",
    title: "notice log",
    description: "everything the app said in this tab",
    section: "system",
    shortcut: "!",
    run: (context) => context.actions.overlay.open("log")
  }
  // Settings registers its command here once step 9 lands:
  // { id: "settings", title: "generation settings", section: "system", shortcut: ",", ... }.
]);
