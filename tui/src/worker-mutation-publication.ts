import type { WorkerMethod } from "../../shared/worker-protocol.js";
import type { StoryAggregateVersion } from "../../shared/story-aggregate-version.js";
import type { MutationOutbox } from "../../server/mutation-outbox.js";
import type { SerializedWorkerOutbox } from "./worker-outbox.js";

interface MutationPublicationOptions {
  mutationId: string;
  method: WorkerMethod;
  input: unknown;
  expectedAggregateVersion?: StoryAggregateVersion;
  signal?: AbortSignal;
  graceMs: number;
  outbox: SerializedWorkerOutbox;
  store: MutationOutbox;
  hardFence(message: string, cause?: unknown): Error;
}

type PublicationResult =
  | { state: "published" }
  | { state: "failed"; error: unknown };

export interface PublishedWorkerMutationIntent {
  cancel(): Promise<void>;
  release(): void;
}

/** Publishes the intent while covering cancellation during publication. A
 * published result lets the caller close the final await handoff before
 * synchronously allocating the worker operation. */
export async function prepareWorkerMutationIntent(
  options: MutationPublicationOptions
): Promise<PublishedWorkerMutationIntent | null> {
  const release = options.outbox.retain();
  try {
    if (await publishWorkerMutationIntent(options)) {
      release();
      return null;
    }
    return {
      cancel: () => persistUnsentCancellation(options),
      release
    };
  } catch (error) {
    release();
    throw error;
  }
}

/** Publishes an intent while bounding caller cancellation before a worker
 * operation exists. Returns true only after cancellation is durable. */
async function publishWorkerMutationIntent(
  options: MutationPublicationOptions
): Promise<boolean> {
  let aborted = options.signal?.aborted === true;
  let publicationSettled = false;
  let publicationTimer: ReturnType<typeof setTimeout> | null = null;
  let resolveAbort!: (result: { state: "aborted" }) => void;
  const abort = new Promise<{ state: "aborted" }>((resolve) => {
    resolveAbort = resolve;
  });
  const onAbort = () => {
    aborted = true;
    clearPublicationDeadline();
    resolveAbort({ state: "aborted" });
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const publication = options.outbox.run(() => options.store.enqueue(
    options.mutationId,
    options.method,
    options.input,
    options.expectedAggregateVersion
  )).then<PublicationResult, PublicationResult>(
    () => ({ state: "published" }),
    (error: unknown) => ({ state: "failed", error })
  );
  let resolveDeadline!: (result: { state: "deadline"; error: Error }) => void;
  const deadline = new Promise<{ state: "deadline"; error: Error }>((resolve) => {
    resolveDeadline = resolve;
  });
  const armPublicationDeadline = () => {
    publicationTimer = setTimeout(() => {
      publicationTimer = null;
      resolveDeadline({
        state: "deadline",
        error: options.hardFence(
          `Embedded backend ${options.method} mutation intent publication did not settle within ${options.graceMs} ms`
        )
      });
    }, options.graceMs);
  };
  function clearPublicationDeadline(): void {
    if (publicationTimer !== null) clearTimeout(publicationTimer);
    publicationTimer = null;
  }
  void publication.then(() => {
    publicationSettled = true;
    clearPublicationDeadline();
  });
  armPublicationDeadline();

  try {
    const first = aborted ? { state: "aborted" as const } : await Promise.race([
      publication,
      abort,
      deadline
    ]);
    if (first.state === "deadline") throw first.error;
    if (first.state === "failed") throw publicationFailure(options, first.error);
    if (first.state === "published"
      && !aborted
      && options.signal?.aborted !== true) {
      return false;
    }
    clearPublicationDeadline();
    await persistUnsentCancellation(options);
    if (!publicationSettled) armPublicationDeadline();
    return true;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }
}

async function persistUnsentCancellation(
  options: MutationPublicationOptions
): Promise<void> {
  const cancellation = options.outbox.runIndependent(
    () => options.store.cancel(options.mutationId)
  ).catch((error: unknown) => {
    throw options.hardFence(
      `Embedded backend ${options.method} cancellation could not be durably recorded before delivery`,
      error
    );
  });
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(options.hardFence(
      `Embedded backend ${options.method} cancellation was not durably recorded before delivery within ${options.graceMs} ms`
    )), options.graceMs);
  });
  try {
    await Promise.race([cancellation, deadline]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function publicationFailure(
  options: MutationPublicationOptions,
  error: unknown
): Error {
  return options.hardFence(
    `Embedded backend ${options.method} mutation intent publication failed`,
    error
  );
}
