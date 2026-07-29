import {
  parseConcurrencyAcquisition,
  requireConcurrencyGroup,
  type GitHubConcurrencyAcquisition
} from "./release-github-concurrency.js";

const MAX_CONCURRENCY_PAGES = 100;
const CONCURRENCY_GROUPS_PER_PAGE = 100;
const MAX_CURSOR_BYTES = 1024;

export interface GitHubConcurrencyClientOptions {
  readonly repository: string;
  readonly apiUrl: string;
  readonly request: (pathname: string) => Promise<Response>;
  readonly readJson: (response: Response) => Promise<unknown>;
}

export async function readGitHubConcurrencyAcquisition(
  options: GitHubConcurrencyClientOptions,
  groupName: string
): Promise<GitHubConcurrencyAcquisition> {
  requireConcurrencyGroup(groupName);
  const endpoint = `repos/${options.repository}/actions/concurrency_groups`;
  const pages: unknown[] = [];
  const dates: Array<string | null> = [];
  const cursors = new Set<string>();
  let after: string | null = null;
  for (let page = 0; page < MAX_CONCURRENCY_PAGES; page += 1) {
    const query = `?per_page=${CONCURRENCY_GROUPS_PER_PAGE}`
      + (after === null ? "" : `&after=${encodeURIComponent(after)}`);
    const response = await options.request(`${endpoint}${query}`);
    if (response.status !== 200) {
      throw new Error(
        `GitHub ref store returned ${response.status}`
          + " while reading concurrency groups"
      );
    }
    pages.push(await options.readJson(response));
    dates.push(response.headers.get("date"));
    const next = concurrencyNextCursor(
      response.headers.get("link"),
      new URL(endpoint, options.apiUrl)
    );
    if (next === null) {
      return parseConcurrencyAcquisition(pages, dates, groupName);
    }
    if (cursors.has(next)) {
      throw new Error("GitHub ref store concurrency pagination repeats a cursor");
    }
    cursors.add(next);
    after = next;
  }
  throw new Error("GitHub ref store concurrency groups exceed the pagination bound");
}

function concurrencyNextCursor(
  value: string | null,
  endpoint: URL
): string | null {
  if (value === null) return null;
  let next: string | null = null;
  for (const entry of value.split(",")) {
    const match = /^\s*<([^<>]+)>([\s\S]*)$/u.exec(entry);
    if (match === null) {
      throw new Error("GitHub ref store concurrency pagination link is invalid");
    }
    const relations = [...match[2]!.matchAll(/;\s*rel="([^"]+)"/gu)]
      .flatMap((relation) => relation[1]!.split(/\s+/u));
    if (!relations.includes("next")) continue;
    if (next !== null) {
      throw new Error("GitHub ref store concurrency pagination repeats its next link");
    }
    const url = new URL(match[1]!);
    const after = url.searchParams.getAll("after");
    const perPage = url.searchParams.getAll("per_page");
    const keys = [...url.searchParams.keys()];
    if (url.origin !== endpoint.origin || url.pathname !== endpoint.pathname
      || after.length !== 1 || after[0] === ""
      || Buffer.byteLength(after[0]!) > MAX_CURSOR_BYTES
      || perPage.length !== 1
      || perPage[0] !== String(CONCURRENCY_GROUPS_PER_PAGE)
      || keys.some((key) => key !== "after" && key !== "per_page")) {
      throw new Error("GitHub ref store concurrency next link is invalid");
    }
    next = after[0]!;
  }
  return next;
}
