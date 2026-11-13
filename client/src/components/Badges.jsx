import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Sparkles,
  Rocket,
  MessageSquare,
  Mic,
  HeartHandshake,
  Heart,
  Bug,
  Star,
  BadgeCheck,
  Award
} from 'lucide-react';
import founderImage from '../assets/badges/badge_founder.png';
import pioneerImage from '../assets/badges/badge_pioneer.png';
import staffMemberImage from '../assets/badges/badge_staff_member.png';
import chatterboxImage from '../assets/badges/badge_chatterbox.png';
import voiceVeteranImage from '../assets/badges/badge_voice_veteran.png';
import helperImage from '../assets/badges/badge_helper.png';
import bugHunterImage from '../assets/badges/badge_bug_hunter.png';
import starImage from '../assets/badges/badge_shining_star.png';

export const BADGE_META = {
  founder: { label: 'Founder', color: '#f5b544', icon: Sparkles, image: founderImage, description: 'Created the very first Cordia account.' },
  pioneer: { label: 'Pioneer', color: '#2dd4bf', icon: Rocket, image: pioneerImage, description: 'Joined during the first wave of Cordia.' },
  staff_member: { label: 'Staff Member', color: '#c7bcff', icon: BadgeCheck, image: staffMemberImage, description: 'Part of the Cordia crew.' },
  chatterbox: { label: 'Chatterbox', color: '#a78bfa', icon: MessageSquare, image: chatterboxImage, description: 'Sent 100 messages.' },
  voice_veteran: { label: 'Voice Veteran', color: '#38bdf8', icon: Mic, image: voiceVeteranImage, description: 'Spent an hour talking in voice channels.' },
  helper: { label: 'Helper', color: '#f472b6', icon: HeartHandshake, image: helperImage, description: 'Recognised for helping others.' },
  bug_hunter: { label: 'Bug Hunter', color: '#fb7185', icon: Bug, image: bugHunterImage, description: 'Found and reported a nasty bug.' },
  star: { label: 'Shining Star', color: '#facc15', icon: Star, image: starImage, description: 'Made the community brighter.' },
  supporter: { label: 'Supporter', color: '#f5b544', icon: Heart, description: 'Helped keep Cordia running.' }
};

export const GRANTABLE_BADGES = ['helper', 'bug_hunter', 'star', 'staff_member', 'supporter'];

function badgeMeta(badge) {
  const key = typeof badge === 'string' ? badge : badge.key;
  return BADGE_META[key] || {
    label: typeof badge === 'object' ? badge.label : key,
    color: '#94a3b8',
    icon: Award,
    description: typeof badge === 'object' ? badge.description : ''
  };
}

export function BadgeArt({ badge, size = 18, className = '' }) {
  const meta = badgeMeta(badge);
  if (meta.image) {
    return (
      <img
        className={`badge-art ${className}`.trim()}
        src={meta.image}
        alt=""
        width={size}
        height={size}
        draggable={false}
        style={{ width: size, height: size }}
      />
    );
  }
  const Icon = typeof meta.icon === 'function' ? meta.icon : Award;
  return <Icon size={size} strokeWidth={2.2} className={className} />;
}

export function BadgeButton({ badge, size = 28, className = '', color }) {
  const meta = badgeMeta(badge);
  const tone = color || meta.color;
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState({ left: 0, top: 0, above: false });
  const buttonRef = useRef(null);
  const popoverRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    function close() {
      setOpen(false);
    }

    function onPointerDown(event) {
      if (buttonRef.current?.contains(event.target) || popoverRef.current?.contains(event.target)) return;
      close();
    }

    function onKeyDown(event) {
      if (event.key === 'Escape') close();
    }

    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [open]);

  function toggle(event) {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const half = 124;
    const left = Math.min(Math.max(rect.left + rect.width / 2, half + 10), window.innerWidth - half - 10);
    const above = rect.bottom + 170 > window.innerHeight;
    setPlacement({ left, top: above ? rect.top - 8 : rect.bottom + 8, above });
    setOpen((value) => !value);
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`badge-button ${className}`.trim()}
        style={{ '--badge-color': tone }}
        onClick={toggle}
        aria-label={`${meta.label} badge`}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <BadgeArt badge={badge} size={size} />
      </button>
      {open
        ? createPortal(
            <div
              ref={popoverRef}
              className={`badge-popover${placement.above ? ' is-above' : ''}`}
              style={{ left: placement.left, top: placement.top, '--badge-color': tone }}
              role="dialog"
              aria-label={`${meta.label} badge details`}
            >
              <BadgeArt badge={badge} size={54} />
              <strong>{meta.label}</strong>
              {meta.description && <p>{meta.description}</p>}
            </div>,
            document.body
          )
        : null}
    </>
  );
}

export function BadgeChip({ badge, size = 'md' }) {
  const key = typeof badge === 'string' ? badge : badge.key;
  const meta = badgeMeta(badge);
  return (
    <span
      className={`badge-chip badge-${size}`}
      style={{ '--badge-color': meta.color }}
      title={meta.description || meta.label}
    >
      <BadgeArt badge={key} size={size === 'sm' ? 18 : 20} className="badge-chip-art" />
    </span>
  );
}


export function BadgeIcon({ badge, size = 22 }) {
  return <BadgeButton badge={badge} size={size} className="badge-icon-button" />;
}
