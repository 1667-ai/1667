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

export interface UpgradeManualEnvelope extends UpgradeSuccessEnvelopeBase {
  status: "manual";
  method: "manual" | "powershell";
  target: string;
  restartRequired: false;
}

export interface UpgradeAvailableEnvelope extends UpgradeSuccessEnvelopeBase {
  status: "available";
  method: "shell";
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
        method?: "manual" | "powershell";
        command?: string;
      }
    | {
        status: "available";
        current: string;
        latest: string;
        target: string;
        channel: UpgradeChannel;
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
      method: "shell",
      restartRequired: false,
      command: null,
      error: null
    };
  }
  if (values.status === "manual") {
    return {
      status: "manual",
      current: values.current,
      latest: values.latest,
      target: values.target,
      channel: values.channel,
      method: values.method ?? "manual",
      restartRequired: false,
      command: values.command ?? null,
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
