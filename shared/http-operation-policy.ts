import {
  type WorkerMethod
} from "./worker-protocol.js";
import type { HttpCapabilityScope } from "./http-auth.js";
import type { HttpOperationLifetime } from "./http-operation-protocol.js";

export type ProtectedHttpApiHead = "import" | "settings" | "stories";

export interface HttpOperationPolicy {
  readonly head: ProtectedHttpApiHead;
  readonly scope: HttpCapabilityScope;
  readonly method: WorkerMethod;
  readonly lifetime: HttpOperationLifetime;
}

const HTTP_API_SCOPES = {
  import: "story",
  settings: "admin",
  stories: "story"
} as const satisfies Record<ProtectedHttpApiHead, HttpCapabilityScope>;

const HTTP_OPERATION_LIFETIME_BY_METHOD = {
  listStories: "local",
  listStoriesPage: "local",
  createStory: "local",
  loadStory: "local",
  getUnknownOutcomeStatus: "local",
  previewChapterBreakRemoval: "local",
  renameStory: "local",
  autonameStory: "generation",
  acknowledgeUnknownOutcomes: "local",
  deleteStory: "local",
  exportMarkdown: "transfer",
  switchLine: "local",
  createNode: "local",
  editNode: "local",
  deleteNode: "local",
  pruneUnusedTakes: "local",
  takeFromCut: "local",
  putBookmark: "local",
  deleteBookmark: "local",
  createFact: "local",
  patchFact: "local",
  deleteFact: "local",
  createChapterBreak: "local",
  renameChapterBreak: "local",
  removeChapterBreak: "local",
  restoreChapterBreak: "local",
  summarizeChapter: "generation",
  getSettings: "local",
  saveSettings: "local",
  discardPendingSettings: "local",
  checkModelServer: "provider-check",
  probeContextWindow: "provider-check",
  discoverModels: "provider-check",
  importSillyTavern: "transfer",
  continueStory: "generation",
  rewriteNode: "generation",
  createSummaryTake: "generation"
} as const satisfies Record<WorkerMethod, HttpOperationLifetime>;

/** Frozen HTTP route-to-command policy shared by reservation and clients. */
export function resolveHttpApiRoute(
  httpMethodInput: string,
  path: string
): HttpOperationPolicy {
  const httpMethod = httpMethodInput.toUpperCase();
  const head = apiHead(path);
  const method = httpWorkerMethod(httpMethod, path);
  return {
    head,
    scope: HTTP_API_SCOPES[head],
    method,
    lifetime: HTTP_OPERATION_LIFETIME_BY_METHOD[method]
  };
}

export function httpOperationPolicy(
  httpMethodInput: string,
  path: string
): Pick<HttpOperationPolicy, "method" | "lifetime"> {
  const { method, lifetime } = resolveHttpApiRoute(httpMethodInput, path);
  return { method, lifetime };
}

export function protectedHttpApiScopeForHead(
  value: string
): { readonly head: ProtectedHttpApiHead; readonly scope: HttpCapabilityScope } | null {
  if (value !== "import" && value !== "settings" && value !== "stories") {
    return null;
  }
  return { head: value, scope: HTTP_API_SCOPES[value] };
}

function apiHead(path: string): ProtectedHttpApiHead {
  const head = path.split("/")[2];
  const route = head === undefined ? null : protectedHttpApiScopeForHead(head);
  if (route === null) {
    throw new Error(`No HTTP operation policy for path ${path}`);
  }
  return route.head;
}

function httpWorkerMethod(httpMethod: string, path: string): WorkerMethod {
  if (path === "/api/stories") {
    if (httpMethod === "GET") return "listStories";
    if (httpMethod === "POST") return "createStory";
  }
  if (path === "/api/stories/catalog-page"
    && httpMethod === "POST") return "listStoriesPage";
  if (path === "/api/settings") {
    if (httpMethod === "GET") return "getSettings";
    if (httpMethod === "PUT") return "saveSettings";
  }
  if (path === "/api/settings/pending"
    && httpMethod === "DELETE") return "discardPendingSettings";
  if (path === "/api/settings/check-server"
    && httpMethod === "POST") return "checkModelServer";
  if (path === "/api/settings/probe-context"
    && httpMethod === "POST") return "probeContextWindow";
  if (path === "/api/settings/discover-models"
    && httpMethod === "POST") return "discoverModels";
  if (path === "/api/import/sillytavern"
    && httpMethod === "POST") return "importSillyTavern";

  const parts = path.split("/");
  if (parts[0] !== "" || parts[1] !== "api" || parts[2] !== "stories"
    || parts[3] === undefined || parts[3].length === 0) {
    throw new Error(`No HTTP operation policy for ${httpMethod} ${path}`);
  }
  const sub = parts[4];
  const subId = parts[5];
  const action = parts[6];
  if (sub === undefined && parts.length === 4) {
    if (httpMethod === "GET") return "loadStory";
    if (httpMethod === "PATCH") return "renameStory";
    if (httpMethod === "DELETE") return "deleteStory";
  }
  if (sub === "export" && parts.length === 5
    && httpMethod === "GET") return "exportMarkdown";
  if (sub === "switch" && parts.length === 5
    && httpMethod === "POST") return "switchLine";
  if (sub === "continue" && parts.length === 5
    && httpMethod === "POST") return "continueStory";
  if (sub === "summary-take" && parts.length === 5
    && httpMethod === "POST") return "createSummaryTake";
  if (sub === "autoname" && parts.length === 5
    && httpMethod === "POST") return "autonameStory";
  if (sub === "prune-unused-takes"
    && parts.length === 5
    && httpMethod === "POST") return "pruneUnusedTakes";
  if (sub === "unknown-outcomes" && subId !== undefined) {
    if (action === undefined && parts.length === 6
      && httpMethod === "GET") return "getUnknownOutcomeStatus";
    if (action === "ack" && parts.length === 7
      && httpMethod === "POST") return "acknowledgeUnknownOutcomes";
  }
  if (sub === "chapter-breaks") {
    if (subId === undefined && httpMethod === "POST") return "createChapterBreak";
    if (subId !== undefined && action === undefined) {
      if (httpMethod === "PATCH") return "renameChapterBreak";
      if (httpMethod === "DELETE") return "removeChapterBreak";
    }
    if (subId !== undefined && action === "restore"
      && httpMethod === "POST") return "restoreChapterBreak";
    if (subId !== undefined && action === "summarize"
      && httpMethod === "POST") return "summarizeChapter";
    if (subId !== undefined && action === "preview"
      && httpMethod === "GET") return "previewChapterBreakRemoval";
  }
  if (sub === "nodes") {
    if (subId === undefined && httpMethod === "POST") return "createNode";
    if (subId !== undefined && action === undefined) {
      if (httpMethod === "PATCH") return "editNode";
      if (httpMethod === "DELETE") return "deleteNode";
    }
    if (subId !== undefined && action === "take-from-cut"
      && httpMethod === "POST") return "takeFromCut";
    if (subId !== undefined && action === "rewrite"
      && httpMethod === "POST") return "rewriteNode";
  }
  if (sub === "tags" && subId !== undefined
    && action === undefined && parts.length === 6) {
    if (httpMethod === "PUT") return "putBookmark";
    if (httpMethod === "DELETE") return "deleteBookmark";
  }
  if (sub === "facts" && action === undefined) {
    if (subId === undefined && parts.length === 5
      && httpMethod === "POST") return "createFact";
    if (subId !== undefined && parts.length === 6
      && httpMethod === "PATCH") return "patchFact";
    if (subId !== undefined && parts.length === 6
      && httpMethod === "DELETE") return "deleteFact";
  }
  throw new Error(`No HTTP operation policy for ${httpMethod} ${path}`);
}
