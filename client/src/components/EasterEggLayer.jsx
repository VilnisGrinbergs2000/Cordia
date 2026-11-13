import { useEffect, useRef, useState } from 'react';
import { EGG_EVENT, fireEasterEgg, nextEggId } from '../easterEggs';

const CONFETTI_COLORS = [
  '#a78bfa',
  '#6ee7b7',
  '#f472b6',
  '#fbbf24',
  '#60a5fa',
  '#fb7185',
  '#f97316',
  '#e9eeff'
];

const BOOM_COLORS = ['#fb7185', '#f97316', '#fbbf24', '#f5b544'];
const HEART_COLORS = ['❤️', '💜', '💚', '💙', '🤍', '💛'];
const SNOW_FLAKES = ['❄', '❅', '❆', '•'];
const MATRIX_GLYPHS = '01アイウエオカキクケコサシスセソタチツテトナニヌネノ';

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function makeConfetti(detail, countOverride, colorsOverride) {
  const count = countOverride ?? detail.count ?? 90;
  const colors = colorsOverride || detail.colors || CONFETTI_COLORS;
  const originX = detail.x ?? window.innerWidth / 2;
  const originY = detail.y ?? window.innerHeight * 0.16;
  return Array.from({ length: count }, (_, index) => {
    const angle = randomBetween(0, Math.PI * 2);
    const spread = randomBetween(50, 310);
    return {
      id: nextEggId(),
      x: originX + randomBetween(-24, 24),
      y: originY + randomBetween(-16, 16),
      dx: Math.cos(angle) * spread,
      dy: Math.sin(angle) * spread + randomBetween(140, 360),
      rot: randomBetween(-720, 720),
      color: colors[index % colors.length],
      w: randomBetween(5, 10),
      h: randomBetween(8, 17),
      delay: randomBetween(0, 0.18),
      duration: randomBetween(1.35, 2.65),
      round: Math.random() > 0.72
    };
  });
}

function makeMatrix() {
  return Array.from({ length: 28 }, (_, index) => {
    const glyphs = Array.from({ length: 44 }, () => {
      if (index === 7 || index === 19) return 'CORDIA';
      return MATRIX_GLYPHS[Math.floor(Math.random() * MATRIX_GLYPHS.length)];
    });
    return {
      id: nextEggId(),
      left: randomBetween(0, 98),
      delay: randomBetween(-7, 0),
      duration: randomBetween(3.2, 7.5),
      size: randomBetween(10, 17),
      text: glyphs.join('')
    };
  });
}

function makeSnow() {
  return Array.from({ length: 54 }, () => ({
    id: nextEggId(),
    left: randomBetween(0, 100),
    delay: randomBetween(0, 5),
    duration: randomBetween(4.5, 10),
    drift: randomBetween(-80, 80),
    size: randomBetween(10, 24),
    opacity: randomBetween(0.35, 0.9),
    glyph: SNOW_FLAKES[Math.floor(Math.random() * SNOW_FLAKES.length)]
  }));
}

function makeHearts() {
  return Array.from({ length: 30 }, () => ({
    id: nextEggId(),
    left: randomBetween(4, 96),
    delay: randomBetween(0, 2.4),
    duration: randomBetween(2.8, 5.5),
    drift: randomBetween(-90, 90),
    size: randomBetween(15, 34),
    glyph: HEART_COLORS[Math.floor(Math.random() * HEART_COLORS.length)]
  }));
}

export default function EasterEggLayer() {
  const [confetti, setConfetti] = useState([]);
  const [toast, setToast] = useState(null);
  const [vibe, setVibe] = useState(false);
  const [matrix, setMatrix] = useState(null);
  const [snow, setSnow] = useState(null);
  const [hearts, setHearts] = useState(null);
  const [flash, setFlash] = useState(false);
  const timers = useRef(new Set());
  const logoClicks = useRef({ count: 0, last: 0 });
  const konami = useRef({ index: 0 });
  const toastTimer = useRef(null);

  useEffect(() => {
    const KONAMI = [
      'ArrowUp',
      'ArrowUp',
      'ArrowDown',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'ArrowLeft',
      'ArrowRight',
      'b',
      'a'
    ];

    function later(callback, delay) {
      const timer = window.setTimeout(() => {
        timers.current.delete(timer);
        callback();
      }, delay);
      timers.current.add(timer);
      return timer;
    }

    function showToast(text) {
      if (!text) return;
      window.clearTimeout(toastTimer.current);
      setToast({ id: nextEggId(), text });
      toastTimer.current = window.setTimeout(() => setToast(null), 3800);
    }

    function spawnConfetti(detail, count, colors) {
      if (detail.reduced) return;
      const pieces = makeConfetti(detail, count, colors);
      setConfetti((previous) => [...previous.slice(-260), ...pieces]);
      later(() => {
        const ids = new Set(pieces.map((piece) => piece.id));
        setConfetti((previous) => previous.filter((piece) => !ids.has(piece.id)));
      }, 3100);
    }

    function shake(duration = 600) {
      document.body.classList.remove('cordia-shake');
      void document.body.offsetWidth;
      document.body.classList.add('cordia-shake');
      later(() => document.body.classList.remove('cordia-shake'), duration);
    }

    function disco(duration = 10000) {
      document.body.classList.remove('cordia-disco');
      void document.body.offsetWidth;
      document.body.classList.add('cordia-disco');
      later(() => document.body.classList.remove('cordia-disco'), duration);
    }

    function onEgg(event) {
      const detail = event.detail || {};
      if (detail.mega) {
        showToast('All secrets found. You are legendary.');
        spawnConfetti(detail, 260, CONFETTI_COLORS);
        disco(14000);
        return;
      }
      if (detail.message) showToast(detail.message);

      switch (detail.type) {
        case 'confetti':
          spawnConfetti(detail, detail.count, detail.colors);
          break;
        case 'party':
          spawnConfetti(detail, detail.count ?? 130);
          break;
        case 'boom':
          if (!detail.reduced) {
            setFlash(true);
            later(() => setFlash(false), 320);
          }
          shake();
          spawnConfetti(detail, 95, BOOM_COLORS);
          break;
        case 'vibe':
          if (!detail.reduced) {
            setVibe(true);
            later(() => setVibe(false), 2400);
          }
          break;
        case 'matrix':
          if (!detail.reduced) {
            setMatrix(makeMatrix());
            later(() => setMatrix(null), 7200);
          }
          break;
        case 'snow':
          if (!detail.reduced) {
            setSnow(makeSnow());
            later(() => setSnow(null), 10000);
          }
          break;
        case 'hearts':
          if (!detail.reduced) {
            setHearts(makeHearts());
            later(() => setHearts(null), 5800);
          }
          break;
        case 'shake':
          shake();
          break;
        case 'disco':
          disco();
          spawnConfetti(detail, detail.count ?? 140);
          break;
        case 'toast':
        default:
          break;
      }
    }

    function onKeyDown(event) {
      if (event.target.closest?.('input, textarea, [contenteditable="true"]')) return;
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      if (key === KONAMI[konami.current.index]) {
        konami.current.index += 1;
        if (konami.current.index >= KONAMI.length) {
          konami.current.index = 0;
          fireEasterEgg('confetti', {
            count: 190,
            egg: 'konami',
            message: 'Cheat code accepted.'
          });
        }
      } else {
        konami.current.index = key === KONAMI[0] ? 1 : 0;
      }
    }

    function onLogoClick(event) {
      if (!event.target.closest?.('.logo-mark')) return;
      const now = Date.now();
      if (now - logoClicks.current.last > 3000) logoClicks.current.count = 0;
      logoClicks.current.count += 1;
      logoClicks.current.last = now;
      if (logoClicks.current.count < 7) return;
      logoClicks.current.count = 0;
      fireEasterEgg('disco', {
        egg: 'disco',
        message: 'Disco mode engaged.'
      });
    }

    window.addEventListener(EGG_EVENT, onEgg);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('click', onLogoClick, true);
    return () => {
      window.removeEventListener(EGG_EVENT, onEgg);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('click', onLogoClick, true);
      window.clearTimeout(toastTimer.current);
      for (const timer of timers.current) window.clearTimeout(timer);
      timers.current.clear();
      document.body.classList.remove('cordia-disco', 'cordia-shake');
    };
  }, []);

  return (
    <>
      {confetti.length > 0 && (
        <div className="easter-layer easter-confetti" aria-hidden="true">
          {confetti.map((piece) => (
            <span
              key={piece.id}
              className={`easter-confetti-piece ${piece.round ? 'round' : ''}`}
              style={{
                left: `${piece.x}px`,
                top: `${piece.y}px`,
                '--dx': `${piece.dx}px`,
                '--dy': `${piece.dy}px`,
                '--rot': `${piece.rot}deg`,
                '--w': `${piece.w}px`,
                '--h': `${piece.h}px`,
                '--color': piece.color,
                '--delay': `${piece.delay}s`,
                '--duration': `${piece.duration}s`
              }}
            />
          ))}
        </div>
      )}

      {matrix && (
        <div className="easter-layer easter-matrix" aria-hidden="true">
          {matrix.map((column) => (
            <span
              key={column.id}
              style={{
                left: `${column.left}%`,
                animationDelay: `${column.delay}s`,
                animationDuration: `${column.duration}s`,
                fontSize: `${column.size}px`
              }}
            >
              {column.text}
            </span>
          ))}
        </div>
      )}

      {snow && (
        <div className="easter-layer easter-snow" aria-hidden="true">
          {snow.map((flake) => (
            <span
              key={flake.id}
              style={{
                left: `${flake.left}%`,
                animationDelay: `${flake.delay}s`,
                animationDuration: `${flake.duration}s`,
                '--drift': `${flake.drift}px`,
                fontSize: `${flake.size}px`,
                opacity: flake.opacity
              }}
            >
              {flake.glyph}
            </span>
          ))}
        </div>
      )}

      {hearts && (
        <div className="easter-layer easter-hearts" aria-hidden="true">
          {hearts.map((heart) => (
            <span
              key={heart.id}
              style={{
                left: `${heart.left}%`,
                animationDelay: `${heart.delay}s`,
                animationDuration: `${heart.duration}s`,
                '--drift': `${heart.drift}px`,
                fontSize: `${heart.size}px`
              }}
            >
              {heart.glyph}
            </span>
          ))}
        </div>
      )}

      {vibe && <div className="easter-layer easter-vibe" aria-hidden="true" />}
      {flash && <div className="easter-layer easter-flash" aria-hidden="true" />}

      {toast && (
        <div key={toast.id} className="easter-toast" role="status" aria-live="polite">
          <span className="easter-toast-spark">✦</span>
          {toast.text}
        </div>
      )}
    </>
  );
}
