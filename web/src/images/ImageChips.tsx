import { useAppContext } from "../app/context.js";
import { Icon, ICONS } from "../ui/icons.js";
import { imageSizeText, type DraftImage } from "./draft-image.js";

/** The images attached to the composer: a thumbnail each, in the order they
 * go with the take, each with a Remove. The thumbnail is the writer's own
 * file; nothing is fetched. */
export function ImageChips({ storyId, images }: { readonly storyId: string; readonly images: readonly DraftImage[] }) {
  const { actions } = useAppContext();
  if (images.length === 0) return null;
  return (
    <ul className="composer-images" aria-label="Attached images">
      {images.map((image, index) => (
        <li key={image.leaseId} className="composer-image">
          <img className="composer-image-thumb" src={image.previewUrl} alt={`Image ${index + 1}`} />
          <span className="composer-image-meta">{imageSizeText(image.attachment.byteLength)}</span>
          <button
            type="button"
            className="icon-btn composer-image-remove"
            title={`Remove image ${index + 1}`}
            aria-label={`Remove image ${index + 1}`}
            onClick={() => actions.compose.removeImage(storyId, image.leaseId)}
          >
            <Icon path={ICONS.x} />
          </button>
        </li>
      ))}
    </ul>
  );
}
