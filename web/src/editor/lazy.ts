import { lazyView } from "../ui/LazyView.js";

// The inline editor loads when a writer first opens it.
export const PartEditor = lazyView(async () => (await import("./PartEditor.js")).PartEditor, { floating: true });
export const EditorRecovery = lazyView(async () => (await import("./EditorRecovery.js")).EditorRecovery, { floating: true });
