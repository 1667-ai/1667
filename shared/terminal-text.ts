export const CONTROL_MARK = "▪";

const LINE_REGEX = /[\u0000-\u0008\u000A-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g;
const PROSE_REGEX = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029]/g;

const replacer = (ch: string) => (ch === "\r" ? " " : CONTROL_MARK);

export function terminalLineText(value: string): string {
  LINE_REGEX.lastIndex = 0;
  if (!LINE_REGEX.test(value)) return value;
  LINE_REGEX.lastIndex = 0;
  return value.replace(LINE_REGEX, replacer);
}

export function terminalProseText(value: string): string {
  PROSE_REGEX.lastIndex = 0;
  if (!PROSE_REGEX.test(value)) return value;
  PROSE_REGEX.lastIndex = 0;
  return value.replace(PROSE_REGEX, replacer);
}
