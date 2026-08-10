import type { GenerationSettings } from "../shared/types.js";
import type { TimeoutProvenance } from "../shared/failure-envelope.js";
import { ProviderError } from "./errors.js";
import { providerFetch } from "./provider-fetch.js";
import {
  EVENT_HEADROOM_MULTIPLIER,
  maxSseEventBytesFor
} from "./provider-sse-probability-budget.js";
import {
  providerErrorSummary,
  providerRuntimeFor,
  redactProviderBody
} from "./provider-runtime.js";

const MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_SSE_EVENT_BYTES = 1024 * 1024;
const MAX_PARTIAL_EVENT_BYTES = 2 * 1024 * 1024;
const MAX_RAW_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_EVENT_COUNT = 250_000;
const MAX_QUEUED_EVENT_MEMORY_BYTES = 2 * 1024 * 1024;

export async function* providerSseEvents(
  settings: GenerationSettings,
  url: string,
  requestBody: Record<string, unknown>,
  headers: Record<string, string>,
  secrets: readonly string[],
  signal: AbortSignal,
  redact: (value: string, secrets: readonly string[]) => string,
  providerStarted?: () => void | Promise<void>,
  requestPrepared?: () => void,
  isActivityEvent: (event: string) => boolean = () => true,
  isTerminalEvent: (event: string) => boolean = () => false,
  callerSignal: AbortSignal = signal,
  providerTransportFinished?: () => void
): AsyncGenerator<string> {
  const runtime = providerRuntimeFor(settings);
  try {
    new URL(url);
    new Headers(headers);
    JSON.stringify(requestBody);
  } catch (error) {
    throw new ProviderError(
      `Model request is invalid: ${redact(
        error instanceof Error ? error.message : String(error),
        secrets
      )}`
    );
  }
  // A property read, not a narrowed local: the timers assign from their
  // callbacks, which control-flow analysis cannot see.
  const deadlineState: { failure: ProviderDeadline | null } = { failure: null };
  const deadline = new AbortController();
  const totalTimer = setTimeout(() => {
    deadlineState.failure = {
      message: "Model request exceeded its total deadline.",
      timeout: "provider-total"
    };
    deadline.abort();
  }, runtime.timeouts.totalMs);
  let phaseTimer: ReturnType<typeof setTimeout> | null = null;
  const setPhaseTimer = (
    milliseconds: number,
    message: string,
    timeout: TimeoutProvenance
  ) => {
    if (phaseTimer !== null) clearTimeout(phaseTimer);
    phaseTimer = setTimeout(() => {
      deadlineState.failure = { message, timeout };
      deadline.abort();
    }, milliseconds);
  };
  const combinedSignal = AbortSignal.any([signal, deadline.signal]);
  try {
    const body = JSON.stringify(requestBody);
    await providerStarted?.();
    requestPrepared?.();
    setPhaseTimer(
      runtime.timeouts.responseHeaderMs,
      "Model server did not return response headers before the configured deadline.",
      "provider-response-header"
    );
    let response: Response;
    try {
      response = await providerFetch(url, {
        method: "POST",
        headers,
        body,
        signal: combinedSignal
      }, {
        allowInsecurePrivateHttp: runtime.allowInsecureHttp
      });
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (callerSignal.aborted) throw callerSignal.reason;
      if (deadlineState.failure !== null) {
        throw providerDeadlineError(deadlineState.failure);
      }
      if (signal.aborted) throw signal.reason;
      throw new ProviderError(
        `Model request failed: ${safeMessage(error, secrets, redact)}`
      );
    }
    if (phaseTimer !== null) clearTimeout(phaseTimer);
    phaseTimer = null;
    if (!response.ok) {
      let rawText: string;
      try {
        rawText = await boundedResponseText(response);
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        if (callerSignal.aborted) throw callerSignal.reason;
        // A deadline here interrupts the read of a provider rejection's
        // body: the rejection is the failure, so no clean-timeout stamp.
        throw new ProviderError(
          deadlineState.failure?.message
            ?? `Model request failed (${response.status}) while reading its error body: ${
              safeMessage(error, secrets, redact)
            }`,
          response.status
        );
      }
      const text = redactProviderBody(rawText, secrets);
      throw new ProviderError(
        `Model request failed (${response.status}): ${providerErrorSummary(text)}`,
        response.status,
        text
      );
    }
    if (response.body === null) throw new ProviderError("Model response has no body");

    setPhaseTimer(
      runtime.timeouts.firstTokenMs,
      "Model server did not produce stream activity before the configured deadline.",
      "provider-first-token"
    );
    const decoder = new TextDecoder();
    let rawBytes = 0;
    let firstActivity = true;
    const reader = response.body.getReader();
    // Sized to this request: no probabilities asked for keeps today's flat
    // 1 MiB cap; probabilities asked for gets a budget derived from
    // maxTokens and the alternative count
    // (provider-sse-probability-budget.ts). Probabilities-requested is also
    // what gates BoundedProviderSseParser's discard-instead-of-throw path
    // (issue #107 part 1): a request that asked for none keeps today's hard
    // failure on an oversized event.
    const probabilitiesRequested = runtime.tokenProbabilities !== null;
    const maxEventBytes = maxSseEventBytesFor(
      settings.maxTokens,
      runtime.tokenProbabilities,
      MAX_SSE_EVENT_BYTES
    );
    const maxPartialEventBytes = maxEventBytes * EVENT_HEADROOM_MULTIPLIER;
    const maxQueuedEventMemoryBytes = maxEventBytes * EVENT_HEADROOM_MULTIPLIER;
    const events = new ProviderEventQueue(maxQueuedEventMemoryBytes);
    const parser = new BoundedProviderSseParser(
      maxEventBytes,
      maxPartialEventBytes,
      probabilitiesRequested
    );
    let terminalQueued = false;
    const enqueueParsedEvents = async (
      parsedEvents: readonly string[]
    ): Promise<boolean> => {
      for (const event of parsedEvents) {
        if (firstActivity && isActivityEvent(event)) {
          firstActivity = false;
          if (phaseTimer !== null) clearTimeout(phaseTimer);
          phaseTimer = null;
        }
        const terminal = isTerminalEvent(event);
        if (!await events.push(event, terminal)) return false;
        if (terminal) {
          terminalQueued = true;
          break;
        }
      }
      return true;
    };
    const pump = (async () => {
      try {
        let active = true;
        for (;;) {
          if (!firstActivity) {
            setPhaseTimer(
              runtime.timeouts.idleMs,
              "Model stream was idle beyond the configured deadline.",
              "provider-idle"
            );
          }
          const { done, value: chunk } = await reader.read();
          if (!firstActivity && phaseTimer !== null) {
            clearTimeout(phaseTimer);
            phaseTimer = null;
          }
          if (done) break;
          rawBytes += chunk.byteLength;
          if (rawBytes > MAX_RAW_RESPONSE_BYTES) throw responseTooLarge();
          active = await enqueueParsedEvents(
            parser.push(decoder.decode(chunk, { stream: true }))
          );
          if (!active) break;
          if (terminalQueued) break;
        }
        if (active && !terminalQueued) {
          active = await enqueueParsedEvents(parser.push(decoder.decode()));
        }
        if (active && !terminalQueued) {
          throw new ProviderError(
            "Model stream ended before its terminal event."
          );
        }
        if (active) providerTransportFinished?.();
        events.close();
      } catch (error) {
        events.fail(providerStreamFailure(
          error,
          deadlineState.failure,
          callerSignal,
          signal,
          secrets,
          redact
        ));
      } finally {
        clearTimeout(totalTimer);
        if (phaseTimer !== null) clearTimeout(phaseTimer);
        phaseTimer = null;
      }
    })();
    try {
      for (;;) {
        events.throwIfCancellationWins(signal);
        const next = await events.next();
        events.throwIfCancellationWins(signal);
        if (next.done) break;
        yield next.value;
      }
    } finally {
      events.cancel();
      await reader.cancel().catch(() => {});
      await pump;
    }
  } finally {
    clearTimeout(totalTimer);
    if (phaseTimer !== null) clearTimeout(phaseTimer);
  }
}

interface ProviderDeadline {
  readonly message: string;
  readonly timeout: TimeoutProvenance;
}

function providerDeadlineError(deadline: ProviderDeadline): ProviderError {
  return new ProviderError(deadline.message, null, "", {
    timeout: deadline.timeout
  });
}

function providerStreamFailure(
  error: unknown,
  deadlineFailure: ProviderDeadline | null,
  callerSignal: AbortSignal,
  transportSignal: AbortSignal,
  secrets: readonly string[],
  redact: (value: string, secrets: readonly string[]) => string
): unknown {
  // A provider-classified failure is already causal evidence. Preserve it
  // before reading cancellation state that can change while a buffered event
  // or redaction tail is in flight.
  if (error instanceof ProviderError) return error;
  if (callerSignal.aborted) return callerSignal.reason;
  if (deadlineFailure !== null) return providerDeadlineError(deadlineFailure);
  if (transportSignal.aborted) return transportSignal.reason;
  return new ProviderError(
    `Model stream failed: ${safeMessage(error, secrets, redact)}`
  );
}

async function boundedResponseText(response: Response): Promise<string> {
  if (response.body === null) return "";
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > MAX_ERROR_BODY_BYTES) throw responseTooLarge();
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

function safeMessage(
  error: unknown,
  secrets: readonly string[],
  redact: (value: string, secrets: readonly string[]) => string
): string {
  return redact(error instanceof Error ? error.message : String(error), secrets);
}

function responseTooLarge(): ProviderError {
  return new ProviderError("provider_response_too_large: model response exceeded a safety limit.");
}

interface QueuedProviderEvent {
  readonly value: string;
  readonly memoryBytes: number;
}

class ProviderEventQueue {
  private readonly values: Array<QueuedProviderEvent | undefined> = [];
  private head = 0;
  private queuedMemoryBytes = 0;
  private readonly waiters: Array<{
    readonly resolve: (result: IteratorResult<string>) => void;
    readonly reject: (error: unknown) => void;
  }> = [];
  private readonly capacityWaiters: Array<() => void> = [];
  private closed = false;
  private failed = false;
  private failure: unknown;
  private terminalQueued = false;

  constructor(
    private readonly maxQueuedEventMemoryBytes: number = MAX_QUEUED_EVENT_MEMORY_BYTES
  ) {}

  async push(value: string, terminal: boolean): Promise<boolean> {
    if (this.failed) throw this.failure;
    if (this.closed) return false;
    // Terminal evidence belongs to the provider as soon as parsing finds it.
    // Record it before capacity wait. A later Stop must drain queued deltas
    // to release that wait and receive the terminal event.
    if (terminal) this.terminalQueued = true;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ done: false, value });
      return true;
    }
    const memoryBytes = Math.max(1, value.length * 2);
    while (this.queuedMemoryBytes > 0
      && this.queuedMemoryBytes + memoryBytes
        > this.maxQueuedEventMemoryBytes) {
      await new Promise<void>((resolve) => {
        this.capacityWaiters.push(resolve);
      });
      if (this.failed) throw this.failure;
      if (this.closed) return false;
    }
    this.values.push({ value, memoryBytes });
    this.queuedMemoryBytes += memoryBytes;
    return true;
  }

  close(): void {
    if (this.closed || this.failed) return;
    this.closed = true;
    this.releaseCapacityWaiters();
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  cancel(): void {
    if (this.closed || this.failed) return;
    this.closed = true;
    this.values.length = 0;
    this.head = 0;
    this.queuedMemoryBytes = 0;
    this.releaseCapacityWaiters();
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  fail(error: unknown): void {
    if (this.closed || this.failed) return;
    this.failed = true;
    this.failure = error;
    this.values.length = 0;
    this.head = 0;
    this.queuedMemoryBytes = 0;
    this.releaseCapacityWaiters();
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  async next(): Promise<IteratorResult<string>> {
    if (this.failed) throw this.failure;
    if (this.head < this.values.length) {
      const queued = this.values[this.head]!;
      this.values[this.head] = undefined;
      this.head += 1;
      this.queuedMemoryBytes -= queued.memoryBytes;
      if (this.head === this.values.length) {
        this.values.length = 0;
        this.head = 0;
      }
      this.releaseCapacityWaiters();
      return { done: false, value: queued.value };
    }
    if (this.closed) return { done: true, value: undefined };
    return await new Promise<IteratorResult<string>>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  /** Preserve recorded provider failure and terminal evidence before a later
   * caller cancellation. Cancellation can still discard ordinary deltas. */
  throwIfCancellationWins(signal: AbortSignal): void {
    if (this.failed) throw this.failure;
    if (!this.terminalQueued && signal.aborted) throw signal.reason;
  }

  private releaseCapacityWaiters(): void {
    for (const resolve of this.capacityWaiters.splice(0)) resolve();
  }
}

export class BoundedProviderSseParser {
  private lineParts: string[] = [];
  private readonly lineBlocks: string[] = [];
  private lineBytes = 0;
  private partialBytes = 0;
  private eventBytes = 0;
  private pendingEventLineEndingBytes = 0;
  private hasEventLine = false;
  private readonly dataLines: string[] = [];
  private eventCount = 0;
  private pendingCr = false;
  private pendingCrContinuesEvent = false;
  /** Set once the event in progress has crossed maxEventBytes /
   *  maxPartialEventBytes and discardOversizedEvents allows dropping it
   *  instead of throwing (issue #107 part 1). Further bytes for this event
   *  are counted but no longer retained — appendLinePart stops buffering
   *  them and finishLine stops assembling `dataLines` — so a probability
   *  event that runs past even the per-request budget above costs bounded
   *  memory, not unbounded memory, while it is discarded. The stream's own
   *  MAX_RAW_RESPONSE_BYTES and MAX_EVENT_COUNT checks are untouched by this
   *  flag and remain the backstop for a provider that never stops sending. */
  private discardingCurrentEvent = false;

  constructor(
    private readonly maxEventBytes: number = MAX_SSE_EVENT_BYTES,
    private readonly maxPartialEventBytes: number = MAX_PARTIAL_EVENT_BYTES,
    private readonly discardOversizedEvents: boolean = false
  ) {}

  push(chunk: string): readonly string[] {
    const events: string[] = [];
    let offset = 0;
    if (this.pendingCr) {
      this.pendingCr = false;
      if (chunk.startsWith("\n")) {
        if (this.pendingCrContinuesEvent) {
          this.pendingEventLineEndingBytes += 1;
          this.partialBytes += 1;
          this.requirePartialWithinLimit();
        }
        offset = 1;
      }
      this.pendingCrContinuesEvent = false;
    }
    while (offset < chunk.length) {
      let ending = offset;
      while (
        ending < chunk.length
        && chunk[ending] !== "\r"
        && chunk[ending] !== "\n"
      ) {
        ending += 1;
      }
      if (ending === chunk.length) {
        this.appendLinePart(chunk.slice(offset));
        break;
      }
      this.appendLinePart(chunk.slice(offset, ending));
      if (chunk[ending] === "\r") {
        if (chunk[ending + 1] === "\n") {
          this.finishLine(2, events);
          offset = ending + 2;
        } else {
          const continuesEvent = this.finishLine(1, events);
          offset = ending + 1;
          if (offset === chunk.length) {
            this.pendingCr = true;
            this.pendingCrContinuesEvent = continuesEvent;
          }
        }
      } else {
        this.finishLine(1, events);
        offset = ending + 1;
      }
    }
    return events;
  }

  private appendLinePart(value: string): void {
    if (value.length === 0) return;
    const bytes = Buffer.byteLength(value);
    this.lineBytes += bytes;
    this.partialBytes += bytes;
    this.requirePartialWithinLimit();
    // Once this event is known to be discarded, stop paying to buffer
    // content nobody will ever read (see discardingCurrentEvent above).
    if (this.discardingCurrentEvent) return;
    this.lineParts.push(value);
    if (this.lineParts.length === 1_024) {
      this.lineBlocks.push(this.lineParts.join(""));
      this.lineParts = [];
    }
  }

  private finishLine(
    endingBytes: number,
    events: string[]
  ): boolean {
    const lineBytes = this.lineBytes;
    const line = this.takeLine();
    this.lineBytes = 0;
    if (line.length === 0) {
      this.eventCount += 1;
      // Unconditional: a request that asked for probabilities may discard
      // one oversized event, but a provider that never stops sending events
      // is still cut off here regardless (issue #107 part 1's own
      // constraint).
      if (this.eventCount > MAX_EVENT_COUNT) throw responseTooLarge();
      if (this.eventBytes > this.maxEventBytes) {
        if (!this.discardOversizedEvents) throw responseTooLarge();
        this.discardingCurrentEvent = true;
      }
      if (!this.discardingCurrentEvent) {
        const data = this.dataLines.join("\n");
        if (data.length > 0) events.push(data);
      }
      this.resetEvent();
      return false;
    }
    if (this.hasEventLine) {
      this.eventBytes += this.pendingEventLineEndingBytes;
    }
    this.eventBytes += lineBytes;
    if (this.eventBytes > this.maxEventBytes) {
      if (!this.discardOversizedEvents) throw responseTooLarge();
      this.discardingCurrentEvent = true;
    }
    this.hasEventLine = true;
    this.pendingEventLineEndingBytes = endingBytes;
    this.partialBytes += endingBytes;
    this.requirePartialWithinLimit();
    if (!this.discardingCurrentEvent && line.startsWith("data:")) {
      this.dataLines.push(line.slice(5).replace(/^ /u, ""));
    }
    return true;
  }

  private takeLine(): string {
    const tail = this.lineParts.join("");
    const line = this.lineBlocks.length === 0
      ? tail
      : [...this.lineBlocks, tail].join("");
    this.lineParts = [];
    this.lineBlocks.length = 0;
    return line;
  }

  private resetEvent(): void {
    this.lineBytes = 0;
    this.partialBytes = 0;
    this.eventBytes = 0;
    this.pendingEventLineEndingBytes = 0;
    this.hasEventLine = false;
    this.dataLines.length = 0;
    this.discardingCurrentEvent = false;
  }

  private requirePartialWithinLimit(): void {
    if (this.partialBytes <= this.maxPartialEventBytes) return;
    if (!this.discardOversizedEvents) throw responseTooLarge();
    this.discardingCurrentEvent = true;
  }
}
