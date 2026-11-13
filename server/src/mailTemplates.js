'use strict';

// Plain string templates, not a template engine. Every message Cordia sends is
// transactional, so the markup is hand-written: a table-based layout is the only
// thing Outlook 2016, Gmail's clipped view and Apple Mail all agree on.

const ACCENT = '#7c6bff';
const ACCENT_DEEP = '#5b57e0';
const INK = '#14151c';
const MUTED = '#6b7085';
const RULE = '#e6e7ee';

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function paragraphs(text) {
  return String(text || '')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:${INK}">${escapeHtml(block).replace(/\n/g, '<br />')}</p>`)
    .join('');
}

function button(href, label) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px">
  <tr><td align="center" bgcolor="${ACCENT_DEEP}" style="border-radius:10px">
    <a href="${escapeHtml(href)}" style="display:inline-block;padding:13px 26px;font-family:'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px">${escapeHtml(label)}</a>
  </td></tr>
</table>`;
}

function layout({ preheader, title, body, origin }) {
  const site = String(origin || '').replace(/\/+$/, '');
  const foot = site
    ? `<a href="${site}/guidelines" style="color:${MUTED};text-decoration:underline">Guidelines</a> &nbsp;·&nbsp;
       <a href="${site}/privacy" style="color:${MUTED};text-decoration:underline">Privacy</a> &nbsp;·&nbsp;
       <a href="${site}/terms" style="color:${MUTED};text-decoration:underline">Terms</a>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="color-scheme" content="light" />
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f5f9;-webkit-font-smoothing:antialiased">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(preheader || '')}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f5f9">
  <tr><td align="center" style="padding:32px 16px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border-radius:16px;border:1px solid ${RULE};overflow:hidden">
      <tr><td style="background:${INK};padding:20px 32px">
        <span style="font-family:'Segoe UI',Helvetica,Arial,sans-serif;font-size:17px;font-weight:700;letter-spacing:.2px;color:#ffffff">Cordia</span>
      </td></tr>
      <tr><td style="padding:32px 32px 8px">
        <h1 style="margin:0 0 18px;font-family:'Segoe UI',Helvetica,Arial,sans-serif;font-size:21px;line-height:1.35;font-weight:700;color:${INK}">${escapeHtml(title)}</h1>
        ${body}
      </td></tr>
      <tr><td style="padding:8px 32px 32px">
        <div style="border-top:1px solid ${RULE};padding-top:18px;font-family:'Segoe UI',Helvetica,Arial,sans-serif;font-size:12px;line-height:1.7;color:${MUTED}">
          Cordia · Latvia · <a href="mailto:admin@cordia.ext.io" style="color:${MUTED};text-decoration:underline">admin@cordia.ext.io</a><br />
          ${foot}
        </div>
      </td></tr>
    </table>
    <div style="max-width:560px;margin:14px auto 0;font-family:'Segoe UI',Helvetica,Arial,sans-serif;font-size:11px;line-height:1.6;color:#9aa0b4;text-align:center">
      You are receiving this because you have a Cordia account.
    </div>
  </td></tr>
</table>
</body>
</html>`;
}

function textFooter(origin) {
  const site = String(origin || '').replace(/\/+$/, '');
  const lines = ['', '—', 'Cordia · Latvia · admin@cordia.ext.io'];
  if (site) lines.push(`${site}/guidelines · ${site}/privacy · ${site}/terms`);
  lines.push('', 'You are receiving this because you have a Cordia account.');
  return lines.join('\n');
}

function verification({ username, url, minutes, origin }) {
  const subject = 'Confirm your email address';
  const body = `
    ${paragraphs(`Hi ${username},\n\nConfirm this address and Cordia can reach you about your account. The link works once and expires in ${minutes} minutes.`)}
    ${button(url, 'Confirm email address')}
    ${paragraphs('If the button does not work, paste this link into your browser:')}
    <p style="margin:0 0 20px;font-family:Consolas,Menlo,monospace;font-size:13px;line-height:1.6;word-break:break-all;color:${ACCENT_DEEP}">${escapeHtml(url)}</p>
    <p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:${MUTED}">Did not create a Cordia account? Ignore this message and nothing happens.</p>`;
  const text = [
    `Hi ${username},`,
    '',
    `Confirm this address and Cordia can reach you about your account. The link works once and expires in ${minutes} minutes.`,
    '',
    url,
    '',
    'Did not create a Cordia account? Ignore this message and nothing happens.',
    textFooter(origin)
  ].join('\n');
  return { subject, html: layout({ preheader: 'One click and your address is confirmed.', title: subject, body, origin }), text };
}

function passwordReset({ username, url, minutes, origin }) {
  const subject = 'Reset your Cordia password';
  const body = `
    ${paragraphs(`Hi ${username},\n\nSomeone asked to reset the password for your account. The link works once and expires in ${minutes} minutes.`)}
    ${button(url, 'Choose a new password')}
    ${paragraphs('If the button does not work, paste this link into your browser:')}
    <p style="margin:0 0 20px;font-family:Consolas,Menlo,monospace;font-size:13px;line-height:1.6;word-break:break-all;color:${ACCENT_DEEP}">${escapeHtml(url)}</p>
    <div style="margin:0 0 20px;padding:14px 16px;border-left:3px solid ${ACCENT};background:#f7f6ff;border-radius:6px">
      <p style="margin:0;font-size:13px;line-height:1.65;color:${INK}"><strong>Your encrypted messages stay encrypted.</strong> A new password does not hand anyone your message history — you still need your recovery code to unlock it on a new device.</p>
    </div>
    <p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:${MUTED}">If this was not you, ignore the message. Your password has not changed.</p>`;
  const text = [
    `Hi ${username},`,
    '',
    `Someone asked to reset the password for your account. The link works once and expires in ${minutes} minutes.`,
    '',
    url,
    '',
    'Your encrypted messages stay encrypted. A new password does not hand anyone your message history — you still need your recovery code to unlock it on a new device.',
    '',
    'If this was not you, ignore the message. Your password has not changed.',
    textFooter(origin)
  ].join('\n');
  return { subject, html: layout({ preheader: 'This link expires in ' + minutes + ' minutes.', title: subject, body, origin }), text };
}

function suspension({ username, reason, url, origin }) {
  const subject = 'Your Cordia account has been suspended';
  const detail = reason
    ? paragraphs(`Reason given:\n\n${reason}`)
    : paragraphs('No reason was recorded.');
  const body = `
    ${paragraphs(`Hi ${username},\n\nAn administrator has suspended your account. You cannot sign in or post until it is restored.`)}
    ${detail}
    ${paragraphs('If you believe this is a mistake, reply to this message or write to admin@cordia.ext.io and a person will read it.')}
    ${url ? button(url, 'Read the Community Guidelines') : ''}`;
  const text = [
    `Hi ${username},`,
    '',
    'An administrator has suspended your account. You cannot sign in or post until it is restored.',
    '',
    reason ? `Reason given:\n${reason}` : 'No reason was recorded.',
    '',
    'If you believe this is a mistake, reply to this message or write to admin@cordia.ext.io and a person will read it.',
    textFooter(origin)
  ].join('\n');
  return { subject, html: layout({ preheader: 'You cannot sign in until it is restored.', title: subject, body, origin }), text };
}

function broadcast({ username, subject, message, origin, unsubscribeUrl }) {
  const body = `
    ${paragraphs(message)}
    <p style="margin:24px 0 0;font-size:12px;line-height:1.6;color:${MUTED}">
      ${unsubscribeUrl ? `<a href="${escapeHtml(unsubscribeUrl)}" style="color:${MUTED};text-decoration:underline">Stop sending me product updates</a>` : ''}
    </p>`;
  const text = [
    username ? `Hi ${username},` : 'Hi,',
    '',
    String(message || '').trim(),
    '',
    unsubscribeUrl ? `Stop sending me product updates: ${unsubscribeUrl}` : '',
    textFooter(origin)
  ]
    .filter((line) => line !== '')
    .join('\n');
  return { subject, html: layout({ preheader: String(message || '').slice(0, 120), title: subject, body, origin }), text };
}

module.exports = { verification, passwordReset, suspension, broadcast, escapeHtml };
