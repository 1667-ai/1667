import {
  type WorkerMethod
} from "./worker-protocol.js";
import type { HttpCapabilityScope } from "./http-auth.js";
import type { HttpOperationLifetime } from "./http-operation-protocol.js";

export type ProtectedHttpApiHead = "import" | "settings" | "stories";
export type HttpCallerCancellationStrategy =
  | "transport-first"
  | "operation-first";

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
  searchStories: "local",
  createStory: "local",
  loadStory: "local",
  planFactConsistency: "local",
  checkFactConsistency: "fact-consistency",
  getFactConsistencyRun: "transfer",
  getUnknownOutcomeStatus: "local",
  previewChapterBreakRemoval: "local",
  renameStory: "local",
  setAuthorsNote: "local",
  setAuthorBrief: "local",
  setFactsBudget: "local",
  setPhraseBias: "local",
  setBannedStrings: "local",
  autonameStory: "generation",
  acknowledgeUnknownOutcomes: "local",
  deleteStory: "local",
  exportMarkdown: "transfer",
  getTokenProbabilities: "local",
  getGenerationRecords: "transfer",
  getGenerationRecord: "transfer",
  getReasoning: "local",
  switchLine: "local",
  createNode: "local",
  editNode: "local",
  deleteNode: "local",
  pruneUnusedTakes: "local",
  takeFromCut: "local",
  pasteStoryLine: "local",
  putBookmark: "local",
  deleteBookmark: "local",
  createFact: "local",
  patchFact: "local",
  deleteFact: "local",
  createFactState: "local",
  patchFactState: "local",
  deleteFactState: "local",
  reorderFact: "local",
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
  // A llama-cpp route resolves against a live tokenize probe on that server
  // (server/context-probe.ts), so this can be a real provider round trip,
  // not always the pure local computation it used to be — same budget as
  // the other provider-probe methods above.
  resolveSamplingBias: "provider-check",
  countPromptTokens: "provider-check",
  importSillyTavern: "transfer",
  importMarkdown: "transfer",
  importNovelAI: "transfer",
  importScenario: "transfer",
  importLorebook: "local",
  importCard: "local",
  continueStory: "generation",
  rewriteNode: "generation",
  // Settling a stashed partial contacts no provider; it is one local
  // splice-and-save.
  commitPartialRewrite: "local",
  createSummaryTake: "generation",
  /** Bounded read of the complete Aside document (up to 1 MiB). */
  getAside: "transfer",
  askAside: "generation",
  clearAside: "local",
  asideSessionMutation: "local",
  retakeAside: "generation",
  // No lifetime class is exactly the 60-second stage deadline. "transfer"
  // (120 s) is the smallest class at or above it; the client requests
  // exactly 60,000 ms, which `resolveHttpOperationReservation` clamps to
  // the class max, so the reservation still gets exactly 60 s.
  stageStoryImage: "transfer",
  // A lease removal touches no normalizer child and no large body; it is
  // one bounded filesystem operation, the same budget as deleteBookmark.
  releaseStoryImage: "local"
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

export function callerCancellationForLifetime(
  lifetime: HttpOperationLifetime
): HttpCallerCancellationStrategy {
  return lifetime === "generation" || lifetime === "fact-consistency"
    ? "operation-first"
    : "transport-first";
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
  if (path === "/api/stories/search"
    && httpMethod === "POST") return "searchStories";
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
  if (path === "/api/settings/resolve-sampling-bias"
    && httpMethod === "POST") return "resolveSamplingBias";
  if (path === "/api/settings/count-tokens"
    && httpMethod === "POST") return "countPromptTokens";
  if (path === "/api/import/sillytavern"
    && httpMethod === "POST") return "importSillyTavern";
  if (path === "/api/import/markdown"
    && httpMethod === "POST") return "importMarkdown";
  if (path === "/api/import/novelai"
    && httpMethod === "POST") return "importNovelAI";
  if (path === "/api/import/scenario"
    && httpMethod === "POST") return "importScenario";

  const parts = path.split("/");
  if (parts[0] !== "" || parts[1] !== "api" || parts[2] !== "stories"
    || parts[3] === undefined || parts[3].length === 0) {
    throw new Error(`No HTTP operation policy for ${httpMethod} ${path}`);
  }
  const sub = parts[4];
  const subId = parts[5];
  const action = parts[6];
  const extra = parts[7];
  // The canonical path shape allows at most one trailing segment beyond
  // `action`, and only the Generation Record detail route consumes it as a
  // record id. Every other route must reject it here, before any branch
  // below gets a chance to match on a shared prefix (e.g. "rewrite") while
  // ignoring a segment that follows it.
  if (parts.length > 8
    || (extra !== undefined
      && !(sub === "nodes" && action === "generation-records" && httpMethod === "GET")
      && !(sub === "facts" && action === "states" && (httpMethod === "PATCH" || httpMethod === "DELETE")))) {
    throw new Error(`No HTTP operation policy for ${httpMethod} ${path}`);
  }
  if (sub === undefined && parts.length === 4) {
    if (httpMethod === "GET") return "loadStory";
    if (httpMethod === "PATCH") return "renameStory";
    if (httpMethod === "DELETE") return "deleteStory";
  }
  if (sub === "fact-consistency") {
    if (subId === undefined && parts.length === 5 && httpMethod === "GET") {
      return "getFactConsistencyRun";
    }
    if (subId === "plan" && parts.length === 6 && httpMethod === "POST") {
      return "planFactConsistency";
    }
    if (subId === "check" && parts.length === 6 && httpMethod === "POST") {
      return "checkFactConsistency";
    }
  }
  if (sub === "export" && parts.length === 5
    && httpMethod === "GET") return "exportMarkdown";
  if (sub === "authors-note" && parts.length === 5
    && httpMethod === "PUT") return "setAuthorsNote";
  if (sub === "author-brief" && parts.length === 5
    && httpMethod === "PUT") return "setAuthorBrief";
  if (sub === "facts-budget" && parts.length === 5
    && httpMethod === "PUT") return "setFactsBudget";
  if (sub === "phrase-bias" && parts.length === 5
    && httpMethod === "PUT") return "setPhraseBias";
  if (sub === "banned-strings" && parts.length === 5
    && httpMethod === "PUT") return "setBannedStrings";
  if (sub === "switch" && parts.length === 5
    && httpMethod === "POST") return "switchLine";
  if (sub === "continue" && parts.length === 5
    && httpMethod === "POST") return "continueStory";
  if (sub === "summary-take" && parts.length === 5
    && httpMethod === "POST") return "createSummaryTake";
  if (sub === "aside") {
    if (subId === undefined && parts.length === 5) {
      if (httpMethod === "GET") return "getAside";
      if (httpMethod === "DELETE") return "clearAside";
    }
    if (subId === "ask" && parts.length === 6 && httpMethod === "POST") {
      return "askAside";
    }
    if (subId === "session" && parts.length === 6 && httpMethod === "POST") {
      return "asideSessionMutation";
    }
    if (subId === "retake" && parts.length === 6 && httpMethod === "POST") {
      return "retakeAside";
    }
  }
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
    // Chapter one is opened by no break, so its rename addresses the
    // collection rather than a member of it.
    if (subId === undefined && httpMethod === "PATCH") return "renameChapterBreak";
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
    if (subId !== undefined && action === "paste-line"
      && httpMethod === "POST") return "pasteStoryLine";
    if (subId !== undefined && action === "rewrite"
      && httpMethod === "POST") return "rewriteNode";
    if (subId !== undefined && action === "rewrite-partial"
      && httpMethod === "POST") return "commitPartialRewrite";
    if (subId !== undefined && action === "token-probabilities"
      && httpMethod === "GET") return "getTokenProbabilities";
    if (subId !== undefined && action === "generation-records") {
      if (parts[7] === undefined && parts.length === 7
        && httpMethod === "GET") return "getGenerationRecords";
      if (parts[7] !== undefined && parts.length === 8
        && httpMethod === "GET") return "getGenerationRecord";
    }
    if (subId !== undefined && action === "reasoning"
      && httpMethod === "GET") return "getReasoning";
  }
  if (sub === "tags" && subId !== undefined
    && action === undefined && parts.length === 6) {
    if (httpMethod === "PUT") return "putBookmark";
    if (httpMethod === "DELETE") return "deleteBookmark";
  }
  if (sub === "import-lorebook" && parts.length === 5 && httpMethod === "POST") return "importLorebook";
  if (sub === "import-card" && parts.length === 5 && httpMethod === "POST") return "importCard";
  if (sub === "images" && subId === undefined && parts.length === 5
    && httpMethod === "POST") return "stageStoryImage";
  if (sub === "images" && subId !== undefined && parts.length === 6
    && httpMethod === "DELETE") return "releaseStoryImage";
  if (sub === "facts" && action === undefined) {

    if (subId === undefined && parts.length === 5
      && httpMethod === "POST") return "createFact";
    if (subId !== undefined && parts.length === 6
      && httpMethod === "PATCH") return "patchFact";
    if (subId !== undefined && parts.length === 6
      && httpMethod === "DELETE") return "deleteFact";
  }
  if (sub === "facts" && subId !== undefined && action === "states") {
    if (parts.length === 7 && httpMethod === "POST") return "createFactState";
    if (parts.length === 8 && extra !== undefined && httpMethod === "PATCH") return "patchFactState";
    if (parts.length === 8 && extra !== undefined && httpMethod === "DELETE") return "deleteFactState";
  }
  if (sub === "facts" && subId !== undefined && action === "reorder"
    && parts.length === 7 && httpMethod === "POST") return "reorderFact";
  throw new Error(`No HTTP operation policy for ${httpMethod} ${path}`);
}
