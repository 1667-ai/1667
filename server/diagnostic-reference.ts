import { randomBytes } from "node:crypto";
import type { DiagnosticReference } from "../shared/diagnostic-reference.js";

/** 96 random bits keep durable cross-process correlation collision-resistant. */
export function createDiagnosticReference(): DiagnosticReference {
  return `err_${randomBytes(12).toString("hex")}` as DiagnosticReference;
}
