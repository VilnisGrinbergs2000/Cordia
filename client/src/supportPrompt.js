// When the tip jar is allowed to interrupt a launch.
//
// The rule is deliberately conservative: a new account is never asked for
// money, an account is asked at most once a fortnight, and even inside that
// window only about one launch in three actually shows the card. A prompt that
// appears every single time stops being a request and becomes a tax.
const SEEN_KEY = 'cordia:support-prompt-seen';
const OFF_KEY = 'cordia:support-prompt-off';

const DAY = 24 * 60 * 60 * 1000;
const NEW_ACCOUNT_GRACE = 3 * DAY;
const REPEAT_AFTER = 14 * DAY;
const SHOW_CHANCE = 0.34;

export function supportPromptDismissed() {
  try {
    return localStorage.getItem(OFF_KEY) === '1';
  } catch {
    // No storage means no memory, and no memory means never nag.
    return true;
  }
}

export function shouldShowSupportPrompt(user, now = Date.now()) {
  if (!user) return false;
  if (supportPromptDismissed()) return false;
  // An account that is hours old has enough to read already.
  const createdAt = Number(user.createdAt) || 0;
  if (createdAt && now - createdAt < NEW_ACCOUNT_GRACE) return false;
  try {
    const seen = Number(localStorage.getItem(SEEN_KEY)) || 0;
    if (now - seen < REPEAT_AFTER) return false;
  } catch {
    return false;
  }
  return Math.random() < SHOW_CHANCE;
}

export function markSupportPromptSeen(now = Date.now()) {
  try {
    localStorage.setItem(SEEN_KEY, String(now));
  } catch {
    // storage may be unavailable
  }
}

export function dismissSupportPromptForever() {
  try {
    localStorage.setItem(OFF_KEY, '1');
  } catch {
    // storage may be unavailable
  }
}
