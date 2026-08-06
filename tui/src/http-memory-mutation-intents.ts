import { createHash } from "node:crypto";
import {
  createDurableMutationId
} from "../../shared/durable-mutation-id.js";
import type {
  HttpMutationIntentClaim,
  HttpMutationIntentOperation,
  HttpMutationIntentStore
} from "./http-mutation-intents.js";

interface MemoryMutationIntent {
  readonly mutationId: string;
  activeClaims: number;
  uncertain: boolean;
}

export class MemoryHttpMutationIntentStore
implements HttpMutationIntentStore {
  private readonly records = new Map<string, MemoryMutationIntent>();

  async claim(
    operation: HttpMutationIntentOperation,
    semanticInput: string
  ): Promise<HttpMutationIntentClaim> {
    const key = createHash("sha256")
      .update("1667-http-memory-mutation-v1", "utf8")
      .update("\0", "utf8")
      .update(operation, "utf8")
      .update("\0", "utf8")
      .update(semanticInput, "utf8")
      .digest("hex");
    const existing = this.records.get(key);
    const record = existing ?? {
      mutationId: createDurableMutationId(),
      activeClaims: 0,
      uncertain: false
    };
    record.activeClaims += 1;
    this.records.set(key, record);
    let settlement: Promise<void> | null = null;
    const settle = (uncertain: boolean): Promise<void> =>
      settlement ??= Promise.resolve().then(() => {
        const current = this.records.get(key);
        if (current !== record) return;
        current.activeClaims -= 1;
        current.uncertain ||= uncertain;
        if (current.activeClaims !== 0) return;
        if (current.uncertain) {
          current.uncertain = false;
        } else {
          this.records.delete(key);
        }
      });
    return {
      mutationId: record.mutationId,
      reused: existing !== undefined,
      complete: async () => await settle(false),
      retain: async () => await settle(true)
    };
  }
}
