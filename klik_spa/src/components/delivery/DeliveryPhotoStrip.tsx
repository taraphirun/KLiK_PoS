import { useState } from "react";
import { ImageOff, Volume2 } from "lucide-react";
import Lightbox from "yet-another-react-lightbox";
import Zoom from "yet-another-react-lightbox/plugins/zoom";
import "yet-another-react-lightbox/styles.css";
import { parseDeliveryPhotos } from "../../services/delivery";

interface DeliveryPhotoStripProps {
  photos?: string | null;
  /** Same shape as photos, index-aligned - see DeliveryReport.photo_thumbnails. Optional/shorter
   * than photos for reports synced before this field existed; any index missing a thumbnail falls
   * back to that photo's own (full-resolution) url. */
  photoThumbnails?: string | null;
  voiceNote?: string | null;
  emptyLabel?: string;
  /** Overrides the default lightbox-on-click behavior (2026-08-06) - CreateInvoiceFromReportModal
   * uses this to open the clicked photo in its own side-by-side panel instead, so staff can keep
   * referencing it while filling out the invoice form rather than it covering the whole screen. */
  onPhotoClick?: (index: number) => void;
}

/** Thumbnail strip for a Delivery Report's attached photos/voice note (Module 15 / Todo 040) -
 * private Frappe files, served same-origin so the browser's existing session cookie covers
 * access (no separate fetch/blob handling needed); read access follows standard Frappe
 * permissions on the Delivery Report each file is attached to. Clicking a thumbnail opens
 * yet-another-react-lightbox with its Zoom plugin (pinch/wheel/double-tap/drag, all built-in) -
 * swapped in for a hand-rolled gesture implementation that never quite matched native feel.
 *
 * The strip itself renders photo_thumbnails, not photos (2026-08-06) - the desktop reconciliation
 * table can have many rows on screen with photos at once, and downloading/decoding full-resolution
 * Telegram originals (often 1-2MB+) for every one of them just to paint a 64px preview was the
 * likely cause of that table janking/blanking on scroll. The lightbox still opens the full-
 * resolution photos array - only the small on-screen preview is downgraded. */
export default function DeliveryPhotoStrip({
  photos,
  photoThumbnails,
  voiceNote,
  emptyLabel,
  onPhotoClick,
}: DeliveryPhotoStripProps) {
  const urls = parseDeliveryPhotos(photos);
  const thumbUrls = parseDeliveryPhotos(photoThumbnails);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  if (urls.length === 0 && !voiceNote) {
    if (!emptyLabel) return null;
    return (
      <div className="flex items-center gap-1.5 text-xs text-gray-400 dark:text-gray-500">
        <ImageOff size={13} />
        {emptyLabel}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {urls.map((url, i) => (
        <button
          key={url}
          type="button"
          onClick={() => (onPhotoClick ? onPhotoClick(i) : setLightboxIndex(i))}
          className="block h-16 w-16 shrink-0 overflow-hidden rounded-md border border-gray-200 hover:opacity-80 dark:border-gray-700"
          title="View photo"
        >
          <img src={thumbUrls[i] || url} alt="Delivery photo" className="h-full w-full object-cover" loading="lazy" />
        </button>
      ))}
      {voiceNote && (
        <audio controls preload="none" src={voiceNote} className="h-10 max-w-[220px]">
          <Volume2 size={14} />
        </audio>
      )}

      {/* Mounted only while actually open (2026-08-06) - this strip renders once per delivery
          report, so the reconciliation table's rows each carry their own instance; leaving
          Lightbox always-mounted (just toggling its `open` prop) meant every visible row paid for
          a full lightbox tree at once, which is likely why the table itself was janking/flashing
          on scroll once there were enough rows on screen to add up. */}
      {lightboxIndex !== null && (
        <Lightbox
          open
          close={() => setLightboxIndex(null)}
          index={lightboxIndex}
          slides={urls.map((url) => ({ src: url }))}
          plugins={[Zoom]}
          zoom={{ scrollToZoom: true, maxZoomPixelRatio: 4, doubleClickMaxStops: 3 }}
        />
      )}
    </div>
  );
}
