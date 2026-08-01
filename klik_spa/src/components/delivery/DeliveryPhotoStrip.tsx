import { useState } from "react";
import { ImageOff, Volume2 } from "lucide-react";
import Lightbox from "yet-another-react-lightbox";
import Zoom from "yet-another-react-lightbox/plugins/zoom";
import "yet-another-react-lightbox/styles.css";
import { parseDeliveryPhotos } from "../../services/delivery";

interface DeliveryPhotoStripProps {
  photos?: string | null;
  voiceNote?: string | null;
  emptyLabel?: string;
}

/** Thumbnail strip for a Delivery Report's attached photos/voice note (Module 15 / Todo 040) -
 * private Frappe files, served same-origin so the browser's existing session cookie covers
 * access (no separate fetch/blob handling needed); read access follows standard Frappe
 * permissions on the Delivery Report each file is attached to. Clicking a thumbnail opens
 * yet-another-react-lightbox with its Zoom plugin (pinch/wheel/double-tap/drag, all built-in) -
 * swapped in for a hand-rolled gesture implementation that never quite matched native feel. */
export default function DeliveryPhotoStrip({ photos, voiceNote, emptyLabel }: DeliveryPhotoStripProps) {
  const urls = parseDeliveryPhotos(photos);
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
          onClick={() => setLightboxIndex(i)}
          className="block h-16 w-16 shrink-0 overflow-hidden rounded-md border border-gray-200 hover:opacity-80 dark:border-gray-700"
          title="View photo"
        >
          <img src={url} alt="Delivery photo" className="h-full w-full object-cover" loading="lazy" />
        </button>
      ))}
      {voiceNote && (
        <audio controls preload="none" src={voiceNote} className="h-10 max-w-[220px]">
          <Volume2 size={14} />
        </audio>
      )}

      <Lightbox
        open={lightboxIndex !== null}
        close={() => setLightboxIndex(null)}
        index={lightboxIndex ?? 0}
        slides={urls.map((url) => ({ src: url }))}
        plugins={[Zoom]}
        zoom={{ scrollToZoom: true, maxZoomPixelRatio: 4, doubleClickMaxStops: 3 }}
      />
    </div>
  );
}
