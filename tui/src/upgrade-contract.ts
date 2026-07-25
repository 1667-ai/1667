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

export interface UpgradeError {
  code: UpgradeErrorCode;
  message: string;
  retryable: boolean;
  details: null;
}

interface UpgradeEnvelopeBase {
  method: "manual";
  restartRequired: false;
  command: null;
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
}

export interface UpgradeManualEnvelope extends UpgradeSuccessEnvelopeBase {
  status: "manual";
  target: string;
}

export type UpgradeSuccessEnvelope =
  | UpgradeUpToDateEnvelope
  | UpgradeManualEnvelope;

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
    | Pick<UpgradeUpToDateEnvelope, "status" | "current" | "latest" | "target" | "channel">
    | Pick<UpgradeManualEnvelope, "status" | "current" | "latest" | "target" | "channel">
): UpgradeSuccessEnvelope {
  return {
    ...values,
    method: "manual",
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
  }
): UpgradeErrorEnvelope {
  return {
    status: "error",
    current: context.current,
    latest: context.latest ?? null,
    target: null,
    channel: context.channel,
    method: "manual",
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
