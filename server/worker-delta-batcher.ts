import {
  MAX_DELTA_BATCH_BYTES,
  MAX_UNACKNOWLEDGED_DELTA_BATCHES,
  MAX_UNACKNOWLEDGED_DELTA_BYTES,
  type WorkerOperationId,
  type WorkerToMainMessage
} from "../shared/worker-protocol.js";
import { DeltaBatcher, splitUtf8 } from "./delta-batcher.js";

type DeltaMessage = Extract<WorkerToMainMessage, { type: "delta" }>;
type Channel = "prose" | "reasoning";
const CHANNELS: readonly Channel[] = ["prose", "reasoning"];

interface ChannelState {
  readonly batcher: DeltaBatcher;
  /** The one batch currently past `DeltaBatcher` and waiting on
   *  `waitForCredit`, if any. See the class comment on `sealUnsent`. */
  inFlight: string | null;
  /** Tail reclaimed by `sealUnsent`, republished by `publishSealed`. */
  sealed: string;
  /** Reasoning only: the latest known running token count, read when a
   *  batch is sent so the count travelling with a batch is never older
   *  than the text it describes. Unused for the prose channel. */
  tokenCount: number;
}

/** Batches generation output over `DeltaBatcher` (the same batching policy
 *  the HTTP path uses, `server/stream-response.ts`) and stops its producer
 *  at a bounded credit window: this class's own contribution is the
 *  postMessage-specific backpressure gate and sequence numbering, not the
 *  batching timing itself.
 *
 *  Reasoning ("thinking") text gets its own `DeltaBatcher` and its own text
 *  accumulator (`channels.reasoning`), so a coalesced batch can never mix
 *  reasoning and story prose into one `text` field. It shares everything
 *  else with prose — the single monotonic `sequence` counter, the
 *  `unacknowledged` bookkeeping, and the credit window — so the transport's
 *  ack/backpressure contract (`tui/src/worker-transport.ts`'s strict
 *  `expectedSequence` check) never has to know there are two channels. */
export class WorkerDeltaBatcher {
  private readonly channels: Record<Channel, ChannelState>;
  private sequence = 0;
  private readonly unacknowledged = new Map<number, number>();
  private unacknowledgedBytes = 0;
  private readonly creditWaiters = new Set<() => void>();
  /** Every accepted `push`/`pushReasoning` that can still append split
   *  chunks to a channel's `sealed` tail. Terminal publication waits for
   *  these producers, so a single provider delta that spans several
   *  batches cannot lose its later chunks. */
  private readonly pendingPushes = new Set<Promise<void>>();
  private disposed = false;
  /** A sealed transport transfers every later `send` handoff into `sealed`.
   *  A normal dispose drops those handoffs. */
  private sealAfterDispose = false;

  constructor(
    private readonly id: WorkerOperationId,
    private readonly post: (message: DeltaMessage) => void
  ) {
    this.channels = {
      prose: this.makeChannel("prose"),
      reasoning: this.makeChannel("reasoning")
    };
  }

  private makeChannel(channel: Channel): ChannelState {
    // The callback closes over `channel` only, not the state object it
    // reads: `send` looks that up from `this.channels[channel]` at call
    // time, so there is no window where the callback could observe an
    // unassigned state, by construction rather than by `DeltaBatcher`
    // never invoking it synchronously.
    const batcher = new DeltaBatcher((text, bytes) => this.send(channel, text, bytes));
    return { batcher, inFlight: null, sealed: "", tokenCount: 0 };
  }

  push(text: string): Promise<void> {
    return this.pushToChannel(this.channels.prose, text);
  }

  /** Same batching/ack/credit machinery as `push`, on its own text
   *  accumulator. `tokenCount` is the running total for the whole reasoning
   *  stream so far; it is recorded immediately so the next batch this
   *  channel sends — whichever text it ends up covering — carries the
   *  freshest count known at send time. */
  pushReasoning(text: string, tokenCount: number): Promise<void> {
    this.channels.reasoning.tokenCount = tokenCount;
    return this.pushToChannel(this.channels.reasoning, text);
  }

  private pushToChannel(state: ChannelState, text: string): Promise<void> {
    const pending = state.batcher.push(text);
    this.pendingPushes.add(pending);
    void pending.then(
      () => this.pendingPushes.delete(pending),
      () => this.pendingPushes.delete(pending)
    );
    return pending;
  }

  async flush(): Promise<void> {
    await Promise.all(CHANNELS.map((channel) => this.channels[channel].batcher.flush()));
  }

  /** Reclaim every accepted-but-unsent batch on both channels now, retain it
   *  for a later bounded delta publication, and dispose the credit-gated
   *  transport. Cancellation uses this at receipt so parked producers
   *  unblock at once. */
  sealUnsent(): void {
    if (this.disposed) return;
    for (const channel of CHANNELS) {
      const state = this.channels[channel];
      state.sealed = state.sealed + (state.inFlight ?? "") + state.batcher.takeBuffered();
      state.inFlight = null;
    }
    this.sealAfterDispose = true;
    this.stopTransport();
  }

  /** Publish each channel's sealed tail after its producers have completed.
   *  These terminal deltas retain normal sequence numbers and batch bounds,
   *  but bypass credit because the terminal must not wait for
   *  acknowledgements. Prose publishes before reasoning, matching the order
   *  a live stream would have delivered them in. */
  async publishSealed(): Promise<void> {
    if (!this.sealAfterDispose) return;
    await this.waitForAcceptedPushes();
    await Promise.all(CHANNELS.map((channel) => this.channels[channel].batcher.flush()));
    for (const channel of CHANNELS) {
      const state = this.channels[channel];
      const tail = state.sealed;
      state.sealed = "";
      for (const text of splitUtf8(tail, MAX_DELTA_BATCH_BYTES)) {
        this.post(this.message(channel, this.sequence++, text));
      }
    }
  }

  acknowledge(sequence: number): void {
    for (const [candidate, bytes] of this.unacknowledged) {
      if (candidate > sequence) break;
      this.unacknowledged.delete(candidate);
      this.unacknowledgedBytes -= bytes;
    }
    this.releaseCreditWaiters();
  }

  dispose(): void {
    this.sealAfterDispose = false;
    for (const channel of CHANNELS) {
      const state = this.channels[channel];
      state.inFlight = null;
      state.sealed = "";
    }
    this.stopTransport();
  }

  private stopTransport(): void {
    this.disposed = true;
    for (const channel of CHANNELS) this.channels[channel].batcher.dispose();
    this.unacknowledged.clear();
    this.unacknowledgedBytes = 0;
    this.releaseCreditWaiters();
  }

  private async send(channel: Channel, text: string, bytes: number): Promise<void> {
    const state = this.channels[channel];
    // An oversized push can still own later split chunks after sealUnsent()
    // releases its first credit-blocked chunk. They were accepted by push()
    // before the deadline, so append each later handoff in source order.
    if (this.disposed) {
      if (this.sealAfterDispose) state.sealed += text;
      return;
    }
    state.inFlight = text;
    await this.waitForCredit(bytes);
    // Sealed or disposed while this waited: never use the credit-gated post.
    if (this.disposed || state.inFlight !== text) return;
    state.inFlight = null;
    const sequence = this.sequence++;
    this.unacknowledged.set(sequence, bytes);
    this.unacknowledgedBytes += bytes;
    this.post(this.message(channel, sequence, text));
  }

  private message(channel: Channel, sequence: number, text: string): DeltaMessage {
    return channel === "reasoning"
      ? { type: "delta", id: this.id, sequence, text, reasoning: { tokenCount: this.channels.reasoning.tokenCount } }
      : { type: "delta", id: this.id, sequence, text };
  }

  private async waitForCredit(bytes: number): Promise<void> {
    while (!this.disposed && (
      this.unacknowledged.size >= MAX_UNACKNOWLEDGED_DELTA_BATCHES
      || this.unacknowledgedBytes + bytes > MAX_UNACKNOWLEDGED_DELTA_BYTES
    )) {
      await new Promise<void>((resolve) => this.creditWaiters.add(resolve));
    }
  }

  private releaseCreditWaiters(): void {
    for (const resolve of this.creditWaiters) resolve();
    this.creditWaiters.clear();
  }

  private async waitForAcceptedPushes(): Promise<void> {
    while (this.pendingPushes.size > 0) {
      await Promise.all(this.pendingPushes);
    }
  }
}
