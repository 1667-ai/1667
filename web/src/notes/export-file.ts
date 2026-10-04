/** A file name for a story title: no characters a file system refuses, and not
 * too long (the TUI's rule, `host/launcher/export-file.ts`). */
export function exportFileBase(title: string): string {
  let name = title
    .replace(/[\u0000-\u001F\u007F-\u009F\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "") || "story";
  if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name)) name = `_${name}`;
  const encoder = new TextEncoder();
  if (encoder.encode(name).length > 120) {
    let bytes = 0;
    let prefix = "";
    for (const scalar of name) {
      const size = encoder.encode(scalar).length;
      if (bytes + size > 120) break;
      prefix += scalar;
      bytes += size;
    }
    name = prefix.trimEnd();
  }
  return name || "story";
}

/** Hands the browser a text file to save. */
export function downloadTextFile(fileName: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: "text/markdown;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
