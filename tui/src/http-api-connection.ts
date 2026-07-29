import { preflightHttpApi } from "../../shared/http-compatibility.js";
import type { HttpApiMetadata } from "../../shared/http-protocol.js";
import type {
  HttpListenerAuthority,
  HttpListenerBinding
} from "../../shared/http-listener-authority.js";
import {
  ApiError,
  ApiRecoveryRequiredError
} from "./api-error.js";

export interface HttpApiConnectionOptions {
  readonly root: string;
  readonly authority: HttpListenerAuthority;
  readonly onMetadata?: (
    metadata: HttpApiMetadata
  ) => boolean | void;
}

/** Owns HTTP compatibility state for one listener authority. */
export class HttpApiConnection {
  private compatibility: Promise<HttpListenerBinding> | null = null;
  private metadata: HttpApiMetadata | null = null;
  private epoch = 0;

  constructor(private readonly options: HttpApiConnectionOptions) {
    if (options.authority.snapshot().authRecord.origin !== options.root) {
      throw new Error("1667 HTTP capability origin does not match --url");
    }
  }

  get recoveryEpoch(): number {
    return this.epoch;
  }

  publishRecoveryWarnings(
    recoveryWarnings: HttpApiMetadata["recoveryWarnings"]
  ): void {
    if (this.metadata === null) return;
    this.publishMetadata({
      ...this.metadata,
      recoveryWarnings
    });
  }

  async run<T>(
    work: (binding: HttpListenerBinding) => Promise<T>,
    refresh = false,
    signal?: AbortSignal,
    mutation = false
  ): Promise<T> {
    const binding = await this.ensureCompatible(
      refresh,
      signal,
      mutation
    );
    try {
      return await work(binding);
    } catch (error) {
      // An application response identifies the negotiated server. A transport
      // failure can mean that the process at this origin changed.
      if (!(error instanceof ApiError)) this.compatibility = null;
      throw error;
    }
  }

  private ensureCompatible(
    refresh: boolean,
    signal: AbortSignal | undefined,
    mutation: boolean
  ): Promise<HttpListenerBinding> {
    if (refresh) this.compatibility = null;
    if (this.compatibility !== null) return this.compatibility;
    const attempt = this.preflightBinding(
      this.options.authority.snapshot(),
      signal,
      mutation,
      true
    ).catch((error: unknown) => {
      if (this.compatibility === attempt) this.compatibility = null;
      throw error;
    });
    this.compatibility = attempt;
    return attempt;
  }

  private async preflightBinding(
    binding: HttpListenerBinding,
    signal: AbortSignal | undefined,
    mutation: boolean,
    allowReplacement: boolean
  ): Promise<HttpListenerBinding> {
    const authority = binding.authRecord;
    let metadata: HttpApiMetadata;
    try {
      metadata = await preflightHttpApi(
        `${this.options.root}/api/health`,
        signal,
        binding.fetch,
        {
          capability: authority.capabilities.story,
          serverInstanceId: authority.instanceId
        }
      );
    } catch (error) {
      if (!allowReplacement || signal?.aborted === true) throw error;
      const outcome =
        await this.options.authority.confirmListenerReplacement(
          authority.instanceId,
          false,
          signal
        );
      if (outcome.kind !== "rebound") throw error;
      return await this.preflightBinding(
        outcome.binding,
        signal,
        mutation,
        false
      );
    }
    if (metadata.serverInstanceId !== authority.instanceId) {
      throw new Error("1667 listener changed after capability discovery");
    }
    const current = this.options.authority.snapshot();
    if (current.authRecord.instanceId !== authority.instanceId) {
      if (!allowReplacement) {
        throw new Error("1667 listener changed during capability discovery");
      }
      return await this.preflightBinding(
        current,
        signal,
        mutation,
        false
      );
    }
    if (this.publishMetadata(metadata) && mutation) {
      throw new ApiRecoveryRequiredError();
    }
    return binding;
  }

  private publishMetadata(metadata: HttpApiMetadata): boolean {
    this.metadata = metadata;
    const changed = this.options.onMetadata?.(metadata) === true;
    if (changed) this.epoch += 1;
    return changed;
  }
}
