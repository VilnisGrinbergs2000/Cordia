import { useEffect, useRef, useState } from 'react';
import { Check, Loader2, RotateCcw } from 'lucide-react';
import Modal from './Modal';

function drawCrop(context, image, target, zoom, focalX, focalY) {
  const scale = Math.max(target / image.naturalWidth, target / image.naturalHeight) * zoom;
  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;
  const x = Math.min(0, Math.max(target - width, target / 2 - width * (focalX / 100)));
  const y = Math.min(0, Math.max(target - height, target / 2 - height * (focalY / 100)));
  context.clearRect(0, 0, target, target);
  context.drawImage(image, x, y, width, height);
}

function makeBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

export default function ServerIconCropModal({
  file,
  onClose,
  onApply,
  title = 'Crop server icon',
  subtitle = 'Choose the square crop and focal point before uploading.',
  applyLabel = 'Use icon'
}) {
  const canvasRef = useRef(null);
  const [imageUrl, setImageUrl] = useState('');
  const [image, setImage] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [focalX, setFocalX] = useState(50);
  const [focalY, setFocalY] = useState(50);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!file) {
      setImageUrl('');
      return undefined;
    }
    const url = URL.createObjectURL(file);
    setImageUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    if (!imageUrl) return undefined;
    let cancelled = false;
    const nextImage = new Image();
    nextImage.onload = () => {
      if (!cancelled) {
        setImage(nextImage);
        setError('');
      }
    };
    nextImage.onerror = () => {
      if (!cancelled) {
        setImage(null);
        setError('That image could not be opened. Try a PNG, JPG, or WebP file.');
      }
    };
    nextImage.src = imageUrl;
    return () => {
      cancelled = true;
    };
  }, [imageUrl]);

  useEffect(() => {
    if (!image || !canvasRef.current) return;
    drawCrop(canvasRef.current.getContext('2d'), image, 320, zoom, focalX, focalY);
  }, [image, zoom, focalX, focalY]);

  function reset() {
    setZoom(1);
    setFocalX(50);
    setFocalY(50);
  }

  async function apply() {
    if (!image) return;
    setSaving(true);
    setError('');
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 512;
      canvas.height = 512;
      drawCrop(canvas.getContext('2d'), image, 512, zoom, focalX, focalY);
      let blob = await makeBlob(canvas, 'image/webp', 0.9);
      if (!blob) blob = await makeBlob(canvas, 'image/jpeg', 0.9);
      if (!blob) throw new Error('Could not prepare that image.');
      await onApply(blob);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      width={520}
      footer={
        <div className="icon-crop-footer">
          <button type="button" className="btn btn-ghost" onClick={reset} disabled={!image || saving}>
            <RotateCcw size={15} /> Reset
          </button>
          <div className="icon-crop-footer-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={apply} disabled={!image || saving}>
              {saving ? <Loader2 size={15} className="spin" /> : <Check size={15} />}
              {applyLabel}
            </button>
          </div>
        </div>
      }
    >
      <div className="icon-crop">
        <div className="icon-crop-stage">
          <canvas ref={canvasRef} width={320} height={320} aria-label="Server icon crop preview" />
          <span className="icon-crop-grid" />
        </div>

        {error && <div className="form-error">{error}</div>}

        <label className="field">
          <span>Zoom</span>
          <input
            type="range"
            min="1"
            max="3"
            step="0.01"
            value={zoom}
            onChange={(event) => setZoom(Number(event.target.value))}
            disabled={!image}
          />
        </label>

        <div className="icon-crop-axis">
          <label className="field">
            <span>Horizontal focal point</span>
            <input
              type="range"
              min="0"
              max="100"
              step="1"
              value={focalX}
              onChange={(event) => setFocalX(Number(event.target.value))}
              disabled={!image}
            />
          </label>
          <label className="field">
            <span>Vertical focal point</span>
            <input
              type="range"
              min="0"
              max="100"
              step="1"
              value={focalY}
              onChange={(event) => setFocalY(Number(event.target.value))}
              disabled={!image}
            />
          </label>
        </div>

        <small className="field-hint">
          The image is resized to 512 x 512 and converted to WebP for fast loading.
        </small>
      </div>
    </Modal>
  );
}
