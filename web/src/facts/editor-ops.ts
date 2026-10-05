import { changedFields } from "./form.js";
import { registerFactEditorOps, type FactEditor } from "./state.js";

function dirty(editor: FactEditor): boolean {
  if (changedFields(editor.base, editor.form).some((field) => field !== "text")) return true;
  const body = editor.body;
  if (body.kind === "fact") return editor.form.text !== editor.base.text;
  if (body.kind === "state" && (body.anchorPartId !== body.baseAnchorPartId || body.ends !== body.baseEnds)) return true;
  if (body.ends) return false;
  return editor.form.text !== body.baseText;
}

function copyText(editor: FactEditor): string {
  const f = editor.form;
  const head = [
    ["Name", f.name.trim()],
    ["Tag", f.tag.trim()],
    ["Activation", f.activation],
    ["Keys", f.keys.trim()],
    ["Secondary keys", f.secondaryKeys.trim()],
    ["Secondary mode", f.secondaryKeys.trim().length > 0 ? f.secondaryMode : ""],
    ["Scan depth", f.scanDepth.trim()],
    ["Chain", f.recursion],
    ["Priority", f.priority],
    ["Fact cap", f.budget.trim()]
  ].filter(([, value]) => value!.length > 0).map(([label, value]) => `${label}: ${value}`);
  return `${head.join("\n")}\n\n${f.text}`;
}

registerFactEditorOps({ dirty, copyText });
