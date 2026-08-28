export const UPGRADE_CHANNELS = ["stable", "beta"] as const;
export type UpgradeChannel = typeof UPGRADE_CHANNELS[number];
export type UpgradeErrorCode =
  | "invalid_arguments"
  | "interrupted"
  | "network_error"
  | "metadata_invalid"
  | "unsupported_target"
  | "verification_failed"
  | "internal_error";

export type UpgradeMethod = "manual" | "powershell" | "shell";

export interface UpgradeError {
  code: UpgradeErrorCode;
  message: string;
  retryable: boolean;
  details: null;
}

interface UpgradeEnvelopeBase {
  method: UpgradeMethod;
  restartRequired: boolean;
  /** Only a PowerShell Installation can report a command. See UpgradeManualEnvelope. */
  command: string | null;
}

interface UpgradeSuccessEnvelopeBase extends UpgradeEnvelopeBase {
  current: string;
  latest: string;
  channel: UpgradeChannel;
  error: null;
}

export interface UpgradeUpToDateEnvelope extends UpgradeSuccessEnvelopeBase {
  status: "up-to-date";
  target: null;
  restartRequired: false;
}

/**
 * A read-only plan. A PowerShell Installation carries the command that applies
 * it. Every other manual Installation has no command. Beta checks use an
 * UpgradeAvailableEnvelope until the user requests installation instructions.
 */
export type UpgradeManualEnvelope =
  | (UpgradeSuccessEnvelopeBase & {
      status: "manual";
      method: "manual";
      command: null;
      target: string;
      restartRequired: false;
    })
  | (UpgradeSuccessEnvelopeBase & {
      status: "manual";
      method: "powershell";
      command: string;
      target: string;
      restartRequired: false;
    });

export interface UpgradeAvailableEnvelope extends UpgradeSuccessEnvelopeBase {
  status: "available";
  method: "shell" | "powershell";
  target: string;
  restartRequired: false;
}

export interface UpgradeAppliedEnvelope extends UpgradeSuccessEnvelopeBase {
  status: "applied";
  method: "shell";
  target: string;
  restartRequired: true;
}

export type UpgradeSuccessEnvelope =
  | UpgradeUpToDateEnvelope
  | UpgradeManualEnvelope
  | UpgradeAvailableEnvelope
  | UpgradeAppliedEnvelope;

export interface UpgradeErrorEnvelope extends UpgradeEnvelopeBase {
  status: "error";
  current: string | null;
  latest: string | null;
  target: null;
  channel: UpgradeChannel | null;
  error: UpgradeError;
}

export type UpgradeEnvelope = UpgradeSuccessEnvelope | UpgradeErrorEnvelope;

export class UpgradeFailure extends Error {
  constructor(
    readonly code: UpgradeErrorCode,
    message: string,
    readonly retryable = false
  ) {
    super(message);
    this.name = "UpgradeFailure";
  }
}

export function upgradeEnvelope(
  values:
    | {
        status: "up-to-date";
        current: string;
        latest: string;
        target: null;
        channel: UpgradeChannel;
        method: UpgradeMethod;
      }
    | {
        status: "manual";
        current: string;
        latest: string;
        target: string;
        channel: UpgradeChannel;
        method: "manual";
      }
    | {
        status: "manual";
        current: string;
        latest: string;
        target: string;
        channel: UpgradeChannel;
        method: "powershell";
        command: string;
      }
    | {
        status: "available";
        current: string;
        latest: string;
        target: string;
        channel: UpgradeChannel;
        method?: "shell" | "powershell";
      }
    | {
        status: "applied";
        current: string;
        latest: string;
        target: string;
        channel: UpgradeChannel;
      }
): UpgradeSuccessEnvelope {
  if (values.status === "applied") {
    return {
      status: "applied",
      current: values.current,
      latest: values.latest,
      target: values.target,
      channel: values.channel,
      method: "shell",
      restartRequired: true,
      command: null,
      error: null
    };
  }
  if (values.status === "available") {
    return {
      status: "available",
      current: values.current,
      latest: values.latest,
      target: values.target,
      channel: values.channel,
      method: values.method ?? "shell",
      restartRequired: false,
      command: null,
      error: null
    };
  }
  if (values.status === "manual") {
    // Field order is the wire contract. Build each member in full rather than
    // spreading a shared prefix, which reorders the optional tail.
    return values.method === "powershell"
      ? {
          status: "manual",
          current: values.current,
          latest: values.latest,
          target: values.target,
          channel: values.channel,
          method: "powershell",
          restartRequired: false,
          command: values.command,
          error: null
        }
      : {
          status: "manual",
          current: values.current,
          latest: values.latest,
          target: values.target,
          channel: values.channel,
          method: "manual",
          restartRequired: false,
          command: null,
          error: null
        };
  }
  return {
    status: "up-to-date",
    current: values.current,
    latest: values.latest,
    target: null,
    channel: values.channel,
    method: values.method,
    restartRequired: false,
    command: null,
    error: null
  };
}

export function upgradeErrorEnvelope(
  failure: UpgradeFailure,
  context: {
    current: string | null;
    latest?: string | null;
    channel: UpgradeChannel | null;
    method?: UpgradeMethod;
  }
): UpgradeErrorEnvelope {
  return {
    status: "error",
    current: context.current,
    latest: context.latest ?? null,
    target: null,
    channel: context.channel,
    method: context.method ?? "manual",
    restartRequired: false,
    command: null,
    error: {
      code: failure.code,
      message: failure.message,
      retryable: failure.retryable,
      details: null
    }
  };
}
