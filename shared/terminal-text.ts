/** Strip terminal control characters from untrusted file names and titles.
 * Every command that prints a name it read from a file goes through this. */
export function plainTerminalText(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F-\u009F]/g, "");
}
