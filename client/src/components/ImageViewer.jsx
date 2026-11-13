import { useEffect, useRef } from 'react';
import { Download, X } from 'lucide-react';

// Pictures open here, in the app. A target="_blank" anchor leaves Cordia behind
// and, on the desktop build, hands the file to the operating system - so the
// conversation you were reading disappears the moment you look at an image.
export default function ImageViewer({ src, name, onClose }) {
  const dialogRef = useRef(null);

  useEffect(() => {
    // The dialog takes focus rather than the close button: a ring around a
    // button nobody pressed reads as a glitch.
    dialogRef.current?.focus();
    function onKey(event) {
      if (event.key !== 'Escape') return;
      // Capture phase: the picture closes before anything behind it reacts.
      event.stopPropagation();
      onClose();
    }
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div
      ref={dialogRef}
      className="image-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={name || 'Image'}
      tabIndex={-1}
      onMouseDown={(event) => {
        if (event.target.closest('.image-viewer-img, .image-viewer-bar')) return;
        onClose();
      }}
    >
      <div className="image-viewer-bar">
        <span className="image-viewer-name" title={name || 'Image'}>
          {name || 'Image'}
        </span>
        <div className="image-viewer-actions">
          <a
            className="icon-btn"
            href={src}
            download={name || 'image'}
            title="Download"
            aria-label={`Download ${name || 'image'}`}
          >
            <Download size={17} />
          </a>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            title="Close"
            aria-label="Close image"
          >
            <X size={18} />
          </button>
        </div>
      </div>
      <div className="image-viewer-stage">
        <img className="image-viewer-img" src={src} alt={name || ''} />
      </div>
    </div>
  );
}
