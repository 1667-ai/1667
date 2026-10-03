import type { TagStatus } from "../../../shared/types.js";

/** A tag's status as a chip — one look for the header, the tag list, and the
 * take preview. Renders nothing for a tag with no status. */
export function StatusChip({ status }: { readonly status: TagStatus }) {
  if (status.length === 0) return null;
  return <span className={`label-chip label-${status.toLowerCase()}`}>{status}</span>;
}
