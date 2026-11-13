require('./pg/env');
const { query } = require('./pg/pool');

const BADGES = {
  founder: {
    label: 'Founder',
    description: 'Created the very first Cordia account.',
    color: '#f5b544',
    icon: 'sparkles',
    grantable: false
  },
  pioneer: {
    label: 'Pioneer',
    description: 'Joined during the first wave of Cordia.',
    color: '#2dd4bf',
    icon: 'rocket',
    grantable: false
  },
  staff_member: {
    label: 'Staff Member',
    description: 'Part of the Cordia crew.',
    color: '#c7bcff',
    icon: 'badge-check',
    grantable: true
  },
  chatterbox: {
    label: 'Chatterbox',
    description: 'Sent 100 messages.',
    color: '#a78bfa',
    icon: 'message-square',
    grantable: false
  },
  voice_veteran: {
    label: 'Voice Veteran',
    description: 'Spent an hour talking in voice channels.',
    color: '#38bdf8',
    icon: 'mic',
    grantable: false
  },
  helper: {
    label: 'Helper',
    description: 'Recognised by the crew for helping others.',
    color: '#f472b6',
    icon: 'heart-handshake',
    grantable: true
  },
  bug_hunter: {
    label: 'Bug Hunter',
    description: 'Found and reported a nasty bug.',
    color: '#fb7185',
    icon: 'bug',
    grantable: true
  },
  star: {
    label: 'Shining Star',
    description: 'Made the community brighter.',
    color: '#facc15',
    icon: 'star',
    grantable: true
  },
  // Granted by hand, one account at a time, to whoever chips in. There is no
  // purchase path any more, so this is the only way the badge can be earned.
  supporter: {
    label: 'Supporter',
    description: 'Helped keep Cordia running.',
    color: '#f5b544',
    icon: 'heart',
    grantable: true
  }
};

async function awardBadge(userId, badge) {
  if (!BADGES[badge]) return false;
  const result = await query(
    'INSERT INTO user_badges (user_id, badge, awarded_at) VALUES ($1, $2, $3) ON CONFLICT (user_id, badge) DO NOTHING',
    [Number(userId), badge, Date.now()]
  );
  return result.rowCount > 0;
}

async function badgesFor(userId) {
  const { rows } = await query(
    'SELECT badge, awarded_at FROM user_badges WHERE user_id = $1 ORDER BY awarded_at ASC',
    [Number(userId)]
  );
  return rows.map((row) => ({
      key: row.badge,
      awardedAt: row.awarded_at,
      ...(BADGES[row.badge] || { label: row.badge, description: '', color: '#94a3b8', icon: 'award' })
  }));
}

function grantableBadges() {
  return Object.entries(BADGES)
    .filter(([, value]) => value.grantable)
    .map(([key, value]) => ({ key, ...value }));
}

function allBadges() {
  return Object.entries(BADGES).map(([key, value]) => ({ key, ...value }));
}

module.exports = { BADGES, awardBadge, badgesFor, grantableBadges, allBadges };
