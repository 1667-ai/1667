import { sliceUnicodeScalarPrefix, unicodeScalarLength } from "./unicode.js";
import { MAX_IMPORT_BYTES, MAX_STORED_TITLE_CHARS } from "./types.js";

const MAX_TITLE_UTF8_BYTES = MAX_STORED_TITLE_CHARS * 4;
const MAX_TITLE_BASE64URL_CHARS = Math.ceil(MAX_TITLE_UTF8_BYTES / 3) * 4;

/** Raw Markdown plus one bounded ASCII metadata line; avoids JSON escape amplification. */
export const MAX_MARKDOWN_HTTP_BODY_BYTES =
  MAX_IMPORT_BYTES + MAX_TITLE_BASE64URL_CHARS + 1;

export interface MarkdownHttpBody {
  readonly markdown: string;
  readonly defaultTitle?: string;
}

export function normalizeMarkdownDefaultTitle(title: string): string {
  return sliceUnicodeScalarPrefix(title, MAX_STORED_TITLE_CHARS);
}

export function encodeMarkdownHttpBody(
  markdown: string,
  defaultTitle?: string
): string {
  const boundedTitle = defaultTitle === undefined
    ? ""
    : normalizeMarkdownDefaultTitle(defaultTitle);
  const encodedTitle = Buffer.from(boundedTitle, "utf8").toString("base64url");
  return `${encodedTitle}\n${markdown}`;
}

export function decodeMarkdownHttpBody(body: string): MarkdownHttpBody {
  const separator = body.indexOf("\n");
  if (separator < 0 || separator > MAX_TITLE_BASE64URL_CHARS) {
    throw new Error("Markdown import metadata is invalid");
  }
  const encodedTitle = body.slice(0, separator);
  if (!/^[A-Za-z0-9_-]*$/u.test(encodedTitle)) {
    throw new Error("Markdown import metadata is invalid");
  }
  let defaultTitle: string | undefined;
  if (encodedTitle.length > 0) {
    const bytes = Buffer.from(encodedTitle, "base64url");
    if (bytes.toString("base64url") !== encodedTitle
      || bytes.byteLength > MAX_TITLE_UTF8_BYTES) {
      throw new Error("Markdown import metadata is invalid");
    }
    try {
      defaultTitle = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("Markdown import metadata is invalid");
    }
    if (unicodeScalarLength(defaultTitle, MAX_STORED_TITLE_CHARS) > MAX_STORED_TITLE_CHARS) {
      throw new Error("Markdown import metadata is invalid");
    }
  }
  return {
    markdown: body.slice(separator + 1),
    ...(defaultTitle === undefined ? {} : { defaultTitle })
  };
}
