declare const diagnosticReferenceBrand: unique symbol;

/** Opaque identifier advertised for a private, persisted diagnostic entry. */
export type DiagnosticReference = string & {
  readonly [diagnosticReferenceBrand]: true;
};

export function isDiagnosticReference(
  value: unknown
): value is DiagnosticReference {
  return typeof value === "string" && /^err_[0-9a-f]{24}$/.test(value);
}
