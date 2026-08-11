/**
 * What a failed generation should do with the Draft Images it carried,
 * keyed on the exact failure code. Modelled on
 * `shared/settings-mutation-failure.ts`'s code table, not on the
 * timeout-provenance allowlist `generation-action.ts` uses for prose: an
 * expired Draft Lease is a distinct, positive fact about one failure, not a
 * clean deadline.
 *
 * Every code except `image_attachment_expired` restores the Draft Images
 * exactly as a failed generation restores its instruction text. Only an
 * expired lease removes the row, because the staged bytes are gone and no
 * retry can reuse them.
 */
export type ImageAttachmentFailureAction = "restore" | "reattach";

export function imageAttachmentFailureAction(
  code: string | null
): ImageAttachmentFailureAction {
  return code === "image_attachment_expired" ? "reattach" : "restore";
}

/** Shown when a restored draft dropped its Draft Images because a lease
 *  expired. ASD-STE100: short, active, one instruction. */
export const IMAGE_REATTACH_NOTICE = "an attached image's lease expired · attach it again";
