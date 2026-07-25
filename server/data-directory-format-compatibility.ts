import type { DataDirectoryFormat } from "./data-directory-layout.js";
import { ServiceError } from "./errors.js";

export interface DataDirectoryFormatReadOptions {
  readonly supportedFormats?: readonly DataDirectoryFormat[];
}

export function requireSupportedDataDirectoryFormat(
  dataFormat: DataDirectoryFormat,
  supportedFormats: readonly DataDirectoryFormat[] | undefined
): void {
  if (supportedFormats === undefined || supportedFormats.includes(dataFormat)) return;
  throw new ServiceError(
    409,
    `1667 data format ${dataFormat} is not supported by this executable.`,
    "data_directory_version_unsupported"
  );
}
