import { useEffect, useRef, useState } from 'react';
import { Maximize2, Minimize2, MonitorUp, X } from 'lucide-react';

export default function VideoViewer({ tile, onClose }) {
  const videoRef = useRef(null);
  const shellRef = useRef(null);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.srcObject = tile.stream;
    el.play().catch(() => {});
  }, [tile.stream]);

  useEffect(() => {
    function onFullscreenChange() {
      setFullscreen(document.fullscreenElement === shellRef.current);
    }
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  function close() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    onClose();
  }

  useEffect(() => {
    function onKeyDown(event) {
      if (event.key === 'Escape') close();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else if (shellRef.current?.requestFullscreen) {
      shellRef.current.requestFullscreen().catch(() => {});
    }
  }

  return (
    <div className="video-viewer-backdrop" onClick={close}>
      <div className="video-viewer" ref={shellRef} onClick={(event) => event.stopPropagation()}>
        <div className="video-viewer-head">
          <span className="video-viewer-title">
            {tile.badge === 'screen' ? <MonitorUp size={14} /> : null}
            {tile.label}
          </span>
          <div className="video-viewer-actions">
            <button
              className="icon-btn"
              onClick={toggleFullscreen}
              title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            >
              {fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </button>
            <button className="icon-btn" onClick={close} title="Close viewer">
              <X size={17} />
            </button>
          </div>
        </div>
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={tile.muted}
          className={tile.mirrored ? 'mirrored' : ''}
        />
      </div>
    </div>
  );
}
