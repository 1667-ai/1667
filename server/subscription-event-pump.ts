import type {
  AssistantMessageEvent,
  AssistantMessageEventStream
} from "@earendil-works/pi-ai";
import type {
  createRequestSignal,
  createTimeoutState
} from "./subscription-adapter-support.js";
import { ProviderError } from "./errors.js";

const MIN_SUBSCRIPTION_QUEUE_MEMORY_BYTES = 2 * 1024 * 1024;

export interface SubscriptionEventPump {
  readonly events: AsyncIterable<AssistantMessageEvent>;
  cancel(): void;
}

interface ConsumerWaiter {
  resolve: (result: IteratorResult<AssistantMessageEvent>) => void;
  reject: (reason: unknown) => void;
}

/** Observe Pi events before downstream backpressure can delay timeout activity. */
export function createSubscriptionEventPump(
  source: AssistantMessageEventStream,
  signal: AbortSignal,
  onProducerEvent: (event: AssistantMessageEvent) => void,
  maxCoalescedDeltaBytes: number,
  requestController: AbortController
): SubscriptionEventPump {
  const iterator = source[Symbol.asyncIterator]();
  const maxQueueMemoryBytes = Math.max(
    MIN_SUBSCRIPTION_QUEUE_MEMORY_BYTES,
    maxCoalescedDeltaBytes * 4
  );
  const queue: Array<{ event: AssistantMessageEvent; memoryBytes: number }> = [];
  const consumers: ConsumerWaiter[] = [];
  let queuedMemoryBytes = 0;
  let stopped = false;
  let finished = false;
  let failure: unknown;
  let hasFailure = false;

  const finish = (error?: unknown): void => {
    if (stopped || finished) return;
    finished = true;
    if (error !== undefined) {
      failure = error;
      hasFailure = true;
    }
    while (consumers.length > 0) {
      const waiter = consumers.shift();
      if (waiter === undefined) continue;
      if (hasFailure) waiter.reject(failure);
      else waiter.resolve({ value: undefined, done: true });
    }
    signal.removeEventListener("abort", cancel);
  };

  const fail = (error: unknown): void => {
    if (stopped || finished) return;
    finished = true;
    stopped = true;
    failure = error;
    hasFailure = true;
    queue.length = 0;
    queuedMemoryBytes = 0;
    while (consumers.length > 0) consumers.shift()?.reject(error);
    signal.removeEventListener("abort", cancel);
    if (!requestController.signal.aborted) requestController.abort(error);
    const close = iterator.return?.();
    void Promise.resolve(close).catch(() => undefined);
  };

  const cancel = (): void => {
    if (stopped) return;
    stopped = true;
    queue.length = 0;
    queuedMemoryBytes = 0;
    while (consumers.length > 0) {
      consumers.shift()?.resolve({ value: undefined, done: true });
    }
    signal.removeEventListener("abort", cancel);
    const close = iterator.return?.();
    void Promise.resolve(close).catch(() => undefined);
  };

  const enqueue = async (event: AssistantMessageEvent): Promise<void> => {
    const eventMemoryBytes = subscriptionEventMemoryBytes(event);
    if (eventMemoryBytes > maxQueueMemoryBytes) {
      throw new ProviderError("Subscription provider event exceeded the bounded buffer.");
    }
    const tail = queue.at(-1);
    const merged = tail === undefined
      ? undefined
      : coalesceSubscriptionEvent(tail.event, event, maxCoalescedDeltaBytes);
    if (tail !== undefined && merged !== undefined) {
      const memoryBytes = subscriptionEventMemoryBytes(merged);
      if (queuedMemoryBytes - tail.memoryBytes + memoryBytes > maxQueueMemoryBytes) {
        throw new ProviderError("Subscription provider event buffer is full.");
      }
      queuedMemoryBytes += memoryBytes - tail.memoryBytes;
      tail.event = merged;
      tail.memoryBytes = memoryBytes;
      return;
    }
    if (queuedMemoryBytes + eventMemoryBytes > maxQueueMemoryBytes) {
      throw new ProviderError("Subscription provider event buffer is full.");
    }
    if (stopped) return;
    const waiter = consumers.shift();
    if (waiter !== undefined) {
      waiter.resolve({ value: event, done: false });
    } else {
      queue.push({ event, memoryBytes: eventMemoryBytes });
      queuedMemoryBytes += eventMemoryBytes;
    }
  };

  const next = (): Promise<IteratorResult<AssistantMessageEvent>> => {
    if (hasFailure) return Promise.reject(failure);
    if (queue.length > 0) {
      const queued = queue.shift();
      queuedMemoryBytes -= queued?.memoryBytes ?? 0;
      return Promise.resolve({ value: queued!.event, done: false });
    }
    if (finished || stopped) return Promise.resolve({ value: undefined, done: true });
    return new Promise<IteratorResult<AssistantMessageEvent>>((resolve, reject) => {
      consumers.push({ resolve, reject });
    });
  };

  const events: AsyncIterable<AssistantMessageEvent> = {
    [Symbol.asyncIterator]() {
      return {
        next,
        return: async () => {
          cancel();
          return { value: undefined, done: true };
        }
      };
    }
  };

  const pump = async (): Promise<void> => {
    try {
      while (!stopped) {
        const item = await iterator.next();
        if (stopped) return;
        if (item.done) {
          finish();
          return;
        }
        if (
          item.value.type === "toolcall_start"
          || item.value.type === "toolcall_delta"
          || item.value.type === "toolcall_end"
        ) {
          throw new ProviderError("Subscription providers cannot return tool calls.");
        }
        onProducerEvent(item.value);
        await enqueue(item.value);
      }
    } catch (error) {
      if (!stopped) fail(error);
    }
  };

  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  void pump();
  return { events, cancel };
}

export function observeSubscriptionEvent(
  event: AssistantMessageEvent,
  timeoutState: ReturnType<typeof createTimeoutState>,
  requestSignal: ReturnType<typeof createRequestSignal>
): void {
  switch (event.type) {
    case "start":
      timeoutState.start();
      break;
    case "text_delta":
    case "thinking_delta":
      timeoutState.activity();
      break;
    case "text_end":
      if (typeof event.content === "string" && event.content.length > 0) {
        timeoutState.activity();
      }
      break;
    case "done":
    case "error":
      timeoutState.clear();
      requestSignal.clear();
      break;
  }
}

function coalesceSubscriptionEvent(
  previous: AssistantMessageEvent,
  next: AssistantMessageEvent,
  maxBytes: number
): AssistantMessageEvent | undefined {
  if (
    previous.type === "text_delta"
    && next.type === "text_delta"
    && previous.contentIndex === next.contentIndex
    && canCoalesceDelta(previous.delta, next.delta, maxBytes)
  ) {
    return { ...previous, delta: previous.delta + next.delta };
  }
  if (
    previous.type === "thinking_delta"
    && next.type === "thinking_delta"
    && previous.contentIndex === next.contentIndex
    && canCoalesceDelta(previous.delta, next.delta, maxBytes)
  ) {
    return { ...previous, delta: previous.delta + next.delta };
  }
  return undefined;
}

function canCoalesceDelta(previous: string, next: string, maxBytes: number): boolean {
  return Buffer.byteLength(previous) + Buffer.byteLength(next) <= maxBytes;
}

function subscriptionEventMemoryBytes(event: AssistantMessageEvent): number {
  switch (event.type) {
    case "text_delta":
    case "thinking_delta":
      return Math.max(64, Buffer.byteLength(event.delta) * 2 + 64);
    case "text_end":
      return Math.max(64, Buffer.byteLength(event.content) * 2 + 64);
    default: {
      let serialized: string | undefined;
      try {
        serialized = JSON.stringify(event);
      } catch {
        return Number.POSITIVE_INFINITY;
      }
      if (serialized === undefined) return Number.POSITIVE_INFINITY;
      return Math.max(256, Buffer.byteLength(serialized) * 2 + 64);
    }
  }
}
