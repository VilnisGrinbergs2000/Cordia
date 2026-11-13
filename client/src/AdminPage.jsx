import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Activity,
  ArrowLeft,
  Ban,
  BadgeCheck,
  CheckCircle2,
  Clock3,
  Crown,
  Flag,
  Hash,
  Image as ImageIcon,
  LayoutDashboard,
  Loader2,
  LogOut,
  Mail,
  MailCheck,
  MessageSquare,
  Radio,
  RefreshCw,
  ScrollText,
  Search,
  Server,
  Shield,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  TrendingUp,
  UserPlus,
  UserRound,
  Users,
  Zap
} from 'lucide-react';
import api from './api';
import { clearNativeToken } from './runtime';
import { disableBackgroundPush } from './push';
import Logo from './components/Logo';
import Avatar from './components/Avatar';
import ServerIcon from './components/ServerIcon';
import Modal from './components/Modal';
import Toast from './components/Toast';
import { BADGE_META, BadgeArt, BadgeChip, GRANTABLE_BADGES } from './components/Badges';
import { formatDate, formatDay, formatDuration, formatTime } from './utils';

const BADGE_PRIORITY = ['staff_member', 'founder', 'pioneer'];

function badgePriority(badge) {
  const key = typeof badge === 'string' ? badge : badge?.key;
  const index = BADGE_PRIORITY.indexOf(key);
  return index === -1 ? BADGE_PRIORITY.length : index;
}

const TABS = [
  {
    key: 'overview',
    label: 'Overview',
    icon: LayoutDashboard,
    blurb: 'A live read on the whole workspace.'
  },
  {
    key: 'users',
    label: 'Users',
    icon: Users,
    blurb: 'Manage access, badges, and account health.'
  },
  {
    key: 'servers',
    label: 'Servers',
    icon: Server,
    blurb: 'Every community under one roof.'
  },
  {
    key: 'reports',
    label: 'Reports',
    icon: Flag,
    blurb: 'Review messages and users reported by the community.'
  },
  {
    key: 'safety',
    label: 'Safety',
    icon: ShieldAlert,
    blurb: 'Spam bursts, mass DMs and predatory patterns, raised automatically.'
  },
  {
    key: 'mail',
    label: 'Email',
    icon: Mail,
    blurb: 'Outbound delivery, and messages to everyone at once.'
  },
  {
    key: 'audit',
    label: 'Audit log',
    icon: ScrollText,
    blurb: 'A trace of every administrative move.'
  }
];

const REPORT_REASONS = {
  harassment: 'Harassment',
  hate_speech: 'Hate speech',
  threats: 'Threats',
  spam: 'Spam or scam',
  sexual_content: 'Sexual content',
  self_harm: 'Self-harm',
  other: 'Other'
};

const REPORT_STATUSES = ['open', 'reviewing', 'resolved', 'dismissed', 'all'];

const AUDIT_META = {
  'user.role': { label: 'Role changed', color: '#a78bfa', icon: Shield },
  'user.suspend': { label: 'User suspended', color: '#fb7185', icon: Ban },
  'user.restore': { label: 'User restored', color: '#34d399', icon: CheckCircle2 },
  'user.delete': { label: 'User deleted', color: '#fb7185', icon: Trash2 },
  'badge.grant': { label: 'Badge granted', color: '#f5b544', icon: Sparkles },
  'badge.revoke': { label: 'Badge revoked', color: '#94a3b8', icon: BadgeCheck },
  'server.delete': { label: 'Server deleted', color: '#fb7185', icon: Server },
  'server.icon': { label: 'Server icon updated', color: '#a78bfa', icon: ImageIcon },
  'server.group.create': { label: 'Group created', color: '#38bdf8', icon: Users },
  'server.group.update': { label: 'Group updated', color: '#38bdf8', icon: Shield },
  'server.group.reorder': { label: 'Group order updated', color: '#38bdf8', icon: Shield },
  'server.group.delete': { label: 'Group deleted', color: '#fb7185', icon: Trash2 },
  'server.member.groups': { label: 'Member groups updated', color: '#a78bfa', icon: UserRound },
  'report.create': { label: 'Report submitted', color: '#f5b544', icon: Flag },
  'report.review': { label: 'Report reviewed', color: '#34d399', icon: ShieldCheck }
};

function Sparkline({ values }) {
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? 100 / (values.length - 1) : 100;
  const points = values
    .map((value, index) => `${index * step},${32 - (value / max) * 26}`)
    .join(' ');
  return (
    <svg className="admin-stat-spark" viewBox="0 0 100 34" preserveAspectRatio="none" aria-hidden="true">
      <polygon points={`0,34 ${points} 100,34`} />
      <polyline points={points} />
    </svg>
  );
}

function pct(part, total) {
  const value = Math.round((Number(part) || 0) / Math.max(1, Number(total) || 0) * 100);
  return `${value}%`;
}

function formatWait(minutes) {
  const value = Number(minutes) || 0;
  if (value < 1) return 'under a minute';
  if (value < 60) return `${value} min`;
  if (value < 60 * 24) return `${Math.round(value / 60)} h`;
  return `${Math.round(value / (60 * 24))} d`;
}

function StatCard({ icon: Icon, label, value, detail, tone = 'violet', spark }) {
  return (
    <article className={`admin-stat tone-${tone}`}>
      <div className="admin-stat-head">
        <span className="admin-stat-icon">
          <Icon size={17} />
        </span>
        <span className="admin-stat-label">{label}</span>
      </div>
      <div className="admin-stat-main">
        <strong className="admin-stat-value">{value}</strong>
        {spark && <Sparkline values={spark} />}
      </div>
      <div className="admin-stat-foot">{detail}</div>
    </article>
  );
}

function ActivityChart({ series }) {
  const niceMax = (value) => {
    const magnitude = 10 ** Math.floor(Math.log10(Math.max(1, value)));
    const step = magnitude / 2;
    return Math.ceil(value / step) * step;
  };
  const messageMax = niceMax(Math.max(1, ...series.map((day) => day.messages)));
  const userMax = niceMax(Math.max(1, ...series.map((day) => day.users)));
  const totalUsers = series.reduce((sum, day) => sum + day.users, 0);
  const totalMessages = series.reduce((sum, day) => sum + day.messages, 0);
  const ticks = (max) =>
    [max, Math.round((max * 2) / 3), Math.round(max / 3), 0].filter(
      (value, index, list) => list.indexOf(value) === index
    );
  const messageTicks = ticks(messageMax);
  const userTicks = ticks(userMax);
  const activeDays = series.filter((day) => day.users || day.messages).length;
  const lastDay = series[series.length - 1];
  const sparse = activeDays === 1 && (lastDay?.users || lastDay?.messages);

  return (
    <div className="admin-chart">
      <div className="admin-chart-summary">
        <div>
          <strong>{totalMessages.toLocaleString()}</strong>
          <span>messages this week</span>
        </div>
        <div>
          <strong>{totalUsers.toLocaleString()}</strong>
          <span>new members this week</span>
        </div>
        <div className="admin-chart-legend">
          <span>
            <i className="chart-legend-dot chart-legend-dot--messages" /> Messages
          </span>
          <span>
            <i className="chart-legend-dot chart-legend-dot--users" /> New members
          </span>
        </div>
      </div>
      {sparse && (
        <div className="admin-chart-note">
          <span className="chart-note-dot" />
          No activity recorded before today
        </div>
      )}
      <div className="admin-chart-body admin-chart-body--dual">
        <div className="admin-chart-axis admin-chart-axis--left">
          {messageTicks.map((tick) => (
            <span key={tick}>{tick}</span>
          ))}
        </div>
        <div className="admin-chart-plot">
          <div className="admin-chart-grid" aria-hidden="true">
            {messageTicks.map((tick) => (
              <span key={tick} />
            ))}
          </div>
          <div className="chart-bars">
            {series.map((day, index) => (
              <div className={`chart-bar-group ${index === series.length - 1 ? 'today' : ''}`} key={day.label}>
                <div className="chart-bar-stack">
                  <span
                    className="chart-bar chart-bar--messages"
                    style={{ height: `${Math.max(4, (day.messages / messageMax) * 100)}%` }}
                    title={`${day.messages} messages`}
                  />
                </div>
                <span className="chart-axis">{day.label}</span>
              </div>
            ))}
          </div>
          <div className="chart-users-layer">
            {series.map((day) => (
              <span className="chart-users-point" key={day.label}>
                <i
                  className="chart-users-dot"
                  style={{ bottom: `${Math.min(96, Math.max(2, (day.users / userMax) * 100))}%` }}
                  title={`${day.users} new members`}
                />
              </span>
            ))}
          </div>
        </div>
        <div className="admin-chart-axis admin-chart-axis--right">
          {userTicks.map((tick) => (
            <span key={tick}>{tick}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

function EmptyState({ icon: Icon, title, copy, action, onAction }) {
  return (
    <div className="admin-empty-state">
      <span className="admin-empty-icon">
        <Icon size={20} />
      </span>
      <strong>{title}</strong>
      <p>{copy}</p>
      {action && (
        <button className="btn btn-ghost btn-sm" onClick={onAction}>
          {action}
        </button>
      )}
    </div>
  );
}

function BadgesModal({ target, onClose, onChanged, notify }) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const granted = new Set((target.badges || []).map((badge) => (typeof badge === 'string' ? badge : badge.key)));

  async function grant(badge) {
    setBusy(badge);
    setError('');
    try {
      const data = await api.post(`/api/admin/users/${target.id}/badges`, { badge });
      onChanged(target.id, data.badges);
      notify({ title: `${BADGE_META[badge]?.label || badge} granted`, message: target.displayName });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function revoke(badge) {
    setBusy(badge);
    setError('');
    try {
      const data = await api.del(`/api/admin/users/${target.id}/badges/${badge}`);
      onChanged(target.id, data.badges);
      notify({ title: `${BADGE_META[badge]?.label || badge} revoked`, message: target.displayName });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  return (
    <Modal
      title={`Badges - ${target.displayName}`}
      subtitle="Earned badges appear automatically. Grantable badges are awarded by the crew."
      onClose={onClose}
      width={560}
      className="admin-badges-modal"
    >
      <div className="admin-badge-list">
        {Object.entries(BADGE_META).map(([key, meta]) => {
          const has = granted.has(key);
          const grantable = GRANTABLE_BADGES.includes(key);
          return (
            <div className={`admin-badge-row ${has ? 'granted' : ''}`} key={key}>
              <span
                className={`admin-badge-icon${meta.image ? ' admin-badge-icon-art' : ''}`}
                style={{ '--badge-color': meta.color }}
              >
                <BadgeArt badge={key} size={28} />
              </span>
              <div className="admin-badge-copy">
                <strong>{meta.label}</strong>
                <p>{meta.description}</p>
              </div>
              {has ? <span className="admin-badge-status has">Granted</span> : null}
              {grantable ? (
                <button
                  className={`btn ${has ? 'btn-ghost' : 'btn-primary'} btn-xs`}
                  disabled={busy === key}
                  onClick={() => (has ? revoke(key) : grant(key))}
                >
                  {busy === key ? <Loader2 size={13} className="spin" /> : has ? 'Revoke' : 'Grant'}
                </button>
              ) : (
                <span className="admin-badge-status">{has ? '' : 'Auto'}</span>
              )}
            </div>
          );
        })}
      </div>
      {error && <div className="form-error">{error}</div>}
    </Modal>
  );
}

function ReportReviewModal({ report, onClose, onSave }) {
  const [status, setStatus] = useState(report.status === 'open' ? 'reviewing' : report.status);
  const [actionTaken, setActionTaken] = useState(report.actionTaken || '');
  const [resolutionNote, setResolutionNote] = useState(report.resolutionNote || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onSave(report, { status, actionTaken, resolutionNote });
      onClose();
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Report #${report.id}`}
      subtitle={`${REPORT_REASONS[report.reason] || report.reason} / ${report.scopeLabel}`}
      onClose={onClose}
      width={560}
      footer={
        <div className="settings-footer-right">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form="report-review-form" className="btn btn-primary btn-sm" disabled={busy}>
            {busy && <Loader2 size={14} className="spin" />}
            Save review
          </button>
        </div>
      }
    >
      <form id="report-review-form" className="report-form" onSubmit={save}>
        <div className="report-review-summary">
          <div>
            <span>Reported user</span>
            <strong>@{report.reportedUser.username}</strong>
          </div>
          <div>
            <span>Reported by</span>
            <strong>@{report.reporter.username}</strong>
          </div>
          <div>
            <span>Message</span>
            <strong>#{report.messageId || 'deleted'}</strong>
          </div>
        </div>

        {report.excerpt ? (
          <div className="report-preview">
            <span>{report.encrypted ? 'Reporter-provided encrypted evidence' : 'Reported message'}</span>
            <blockquote>{report.excerpt}</blockquote>
          </div>
        ) : (
          <div className="report-preview">
            <span>Reported message</span>
            <p>No text content was included.</p>
          </div>
        )}

        {report.details && (
          <div className="report-preview">
            <span>Reporter note</span>
            <p>{report.details}</p>
          </div>
        )}

        {report.attachmentName && (
          <p className="report-attachment">Attachment: {report.attachmentName}</p>
        )}

        <label className="field">
          <span>Status</span>
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="reviewing">Reviewing</option>
            <option value="resolved">Resolved</option>
            <option value="dismissed">Dismissed</option>
            <option value="open">Open</option>
          </select>
        </label>

        <label className="field">
          <span>Action taken</span>
          <input
            value={actionTaken}
            onChange={(event) => setActionTaken(event.target.value)}
            placeholder="e.g. Message removed, warning issued"
            maxLength={500}
          />
        </label>

        <label className="field">
          <span>Internal note</span>
          <textarea
            value={resolutionNote}
            onChange={(event) => setResolutionNote(event.target.value)}
            rows={3}
            maxLength={1000}
            placeholder="Only visible to administrators."
          />
        </label>

        {error && <div className="form-error">{error}</div>}
      </form>
    </Modal>
  );
}

export default function AdminPage({ user, setUser }) {
  const navigate = useNavigate();
  const [tab, setTab] = useState('overview');
  const [overview, setOverview] = useState(null);
  const [activation, setActivation] = useState(null);
  const [users, setUsers] = useState([]);
  const [servers, setServers] = useState([]);
  const [logs, setLogs] = useState([]);
  const [reports, setReports] = useState([]);
  const [safetyEvents, setSafetyEvents] = useState([]);
  const [safetyCounts, setSafetyCounts] = useState({ open: 0, total: 0 });
  const [safetyStatus, setSafetyStatus] = useState('open');
  const [safetyBusy, setSafetyBusy] = useState(0);
  const [reportStatus, setReportStatus] = useState('open');
  const [reportTarget, setReportTarget] = useState(null);
  const [query, setQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [sortBy, setSortBy] = useState('joined');
  const [auditQuery, setAuditQuery] = useState('');
  const [auditAction, setAuditAction] = useState('all');
  const [loading, setLoading] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState('');
  const [badgeTarget, setBadgeTarget] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [mail, setMail] = useState(null);
  const [mailError, setMailError] = useState('');
  const [broadcast, setBroadcast] = useState({ subject: '', message: '', segment: 'verified' });
  const [broadcastCount, setBroadcastCount] = useState(null);
  const [broadcastBusy, setBroadcastBusy] = useState('');
  const [suspendTarget, setSuspendTarget] = useState(null);

  const activeTab = TABS.find((item) => item.key === tab) || TABS[0];
  const todayLabel = new Date().toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric'
  });

  const notify = useCallback((payload) => {
    setNotice({ type: 'success', ...payload });
  }, []);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(null), 3800);
    return () => clearTimeout(timer);
  }, [notice]);

  const loadOverview = useCallback(async () => {
    setLoading('overview');
    try {
      // Activation is a second, independent read: an empty events table (or a
      // failed query) must not stop the workspace pulse from rendering.
      const [pulse, funnel] = await Promise.all([
        api.get('/api/admin/overview'),
        api.get('/api/admin/activation').catch(() => null)
      ]);
      setOverview(pulse);
      setActivation(funnel);
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading('');
    }
  }, []);

  const loadUsers = useCallback(async (search = '') => {
    setLoading('users');
    try {
      const suffix = search ? `?q=${encodeURIComponent(search)}` : '';
      const data = await api.get(`/api/admin/users${suffix}`);
      setUsers(data.users);
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading('');
    }
  }, []);

  const loadServers = useCallback(async () => {
    setLoading('servers');
    try {
      const data = await api.get('/api/admin/servers');
      setServers(data.servers);
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading('');
    }
  }, []);

  const loadLogs = useCallback(async () => {
    setLoading('audit');
    try {
      const data = await api.get('/api/admin/audit');
      setLogs(data.logs);
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading('');
    }
  }, []);

  const loadReports = useCallback(async (status = 'open') => {
    setLoading('reports');
    try {
      const data = await api.get(`/api/admin/reports?status=${encodeURIComponent(status)}`);
      setReports(data.reports);
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading('');
    }
  }, []);

  const loadSafety = useCallback(async (status = 'open') => {
    setLoading('safety');
    try {
      const data = await api.get(`/api/admin/safety?status=${encodeURIComponent(status)}`);
      setSafetyEvents(data.events || []);
      setSafetyCounts(data.counts || { open: 0, total: 0 });
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading('');
    }
  }, []);

  const loadMail = useCallback(async () => {
    setLoading('mail');
    try {
      const data = await api.get('/api/admin/mail');
      setMail(data);
      setMailError('');
    } catch (err) {
      setMailError(err.message);
    } finally {
      setLoading('');
    }
  }, []);

  async function previewBroadcast(segment) {
    setBroadcast((prev) => ({ ...prev, segment }));
    try {
      const data = await api.post('/api/admin/broadcast/preview', { segment });
      setBroadcastCount(data.recipients);
    } catch (err) {
      setMailError(err.message);
    }
  }

  async function sendBroadcast(event) {
    event.preventDefault();
    // Sending mail to everyone is the one button in this console that cannot be
    // undone, so it asks first and names the number of people it will reach.
    const target = broadcastCount == null ? 'everyone in that segment' : broadcastCount + ' people';
    if (!window.confirm(`Send "${broadcast.subject}" to ${target}?`)) return;
    setBroadcastBusy('send');
    try {
      const data = await api.post('/api/admin/broadcast', broadcast);
      setNotice({ type: 'success', message: `Queued for ${data.queued} recipients.` });
      setBroadcast({ subject: '', message: '', segment: broadcast.segment });
      await loadMail();
    } catch (err) {
      setMailError(err.message);
    } finally {
      setBroadcastBusy('');
    }
  }

  async function reviewSafety(event) {
    setSafetyBusy(event.id);
    try {
      await api.post(`/api/admin/safety/${event.id}/review`, { action: 'resolved' });
      setNotice({ type: 'success', message: `Safety event #${event.id} reviewed.` });
      await loadSafety(safetyStatus);
    } catch (err) {
      setError(err.message);
    } finally {
      setSafetyBusy(0);
    }
  }

  useEffect(() => {
    loadOverview();
    loadUsers();
  }, [loadOverview, loadUsers]);

  useEffect(() => {
    if (tab === 'servers' && servers.length === 0) loadServers();
    if (tab === 'audit' && logs.length === 0) loadLogs();
    if (tab === 'reports') loadReports(reportStatus);
    if (tab === 'safety') loadSafety(safetyStatus);
    if (tab === 'mail') loadMail();
  }, [
    tab,
    reportStatus,
    safetyStatus,
    servers.length,
    logs.length,
    loadServers,
    loadLogs,
    loadReports,
    loadSafety,
    loadMail
  ]);

  function refresh() {
    setError('');
    if (tab === 'overview') loadOverview();
    else if (tab === 'users') loadUsers(query.trim());
    else if (tab === 'servers') loadServers();
    else if (tab === 'reports') loadReports(reportStatus);
    else loadLogs();
  }

  async function saveReportReview(report, payload) {
    await api.patch(`/api/admin/reports/${report.id}`, payload);
    setNotice({ type: 'success', message: `Report #${report.id} updated.` });
    await loadReports(reportStatus);
  }

  function switchTab(next) {
    setError('');
    setTab(next);
  }

  async function changeRole(target, role) {
    setBusy(`role-${target.id}`);
    try {
      const data = await api.patch(`/api/admin/users/${target.id}`, { role });
      setUsers((prev) => prev.map((entry) => (entry.id === target.id ? { ...entry, ...data.user } : entry)));
      notify({ title: `${target.displayName} is now ${role === 'admin' ? 'an administrator' : 'a member'}` });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function toggleBan(target) {
    const banned = !target.banned;
    let reason = '';
    if (banned) {
      // The reason is quoted in the email that goes out, so a suspension is a
      // decision the person can read and answer instead of a screen that stops
      // working. Cancel aborts; an empty answer still suspends.
      const answer = window.prompt(
        `Suspend ${target.displayName}? They will be signed out and unable to sign in.\n\nOptional: the reason, included in the email we send them.`,
        ''
      );
      if (answer === null) return;
      reason = answer.trim();
    }
    setBusy(`ban-${target.id}`);
    try {
      const data = await api.patch(`/api/admin/users/${target.id}`, { banned, reason });
      setUsers((prev) => prev.map((entry) => (entry.id === target.id ? { ...entry, ...data.user } : entry)));
      notify({
        title: banned ? `${target.displayName} suspended` : `${target.displayName} restored`,
        type: banned ? 'error' : 'success'
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function removeUser(target) {
    if (!window.confirm(`Permanently delete ${target.displayName}? All their messages, memberships and friendships go with them.`)) {
      return;
    }
    setBusy(`delete-${target.id}`);
    try {
      await api.del(`/api/admin/users/${target.id}`);
      setUsers((prev) => prev.filter((entry) => entry.id !== target.id));
      setOverview((prev) =>
        prev ? { ...prev, totals: { ...prev.totals, users: Math.max(0, prev.totals.users - 1) } } : prev
      );
      setConfirmDelete(null);
      notify({ title: `${target.displayName} deleted`, type: 'error' });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function removeServer(target) {
    if (!window.confirm(`Delete "${target.name}" permanently? Every channel and message will be lost.`)) return;
    setBusy(`server-${target.id}`);
    try {
      await api.del(`/api/admin/servers/${target.id}`);
      setServers((prev) => prev.filter((entry) => entry.id !== target.id));
      setOverview((prev) =>
        prev ? { ...prev, totals: { ...prev.totals, servers: Math.max(0, prev.totals.servers - 1) } } : prev
      );
      notify({ title: `${target.name} deleted`, type: 'error' });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  function updateBadges(userId, badges) {
    const keys = badges.map((badge) => (typeof badge === 'string' ? badge : badge.key));
    setUsers((prev) =>
      prev.map((entry) =>
        entry.id === userId ? { ...entry, badges: keys, badgeCount: keys.length } : entry
      )
    );
    setBadgeTarget((prev) => (prev && prev.id === userId ? { ...prev, badges: keys, badgeCount: keys.length } : prev));
  }

  function onSearch(event) {
    event.preventDefault();
    loadUsers(query.trim());
  }

  function resetUserFilters() {
    setQuery('');
    setRoleFilter('all');
    setStatusFilter('all');
    setSortBy('joined');
    loadUsers('');
  }

  function resetAuditFilters() {
    setAuditQuery('');
    setAuditAction('all');
  }

  async function logout() {
    try {
      await disableBackgroundPush();
    } catch {
      // ignore
    }
    try {
      await api.post('/api/auth/logout');
    } catch {
      // ignore
    }
    clearNativeToken();
    setUser(null);
    navigate('/');
  }

  const adminCount = useMemo(() => users.filter((person) => person.role === 'admin').length, [users]);
  const suspendedCount = useMemo(() => users.filter((person) => person.banned).length, [users]);

  const visibleUsers = useMemo(() => {
    let list = users.filter((person) => {
      if (roleFilter !== 'all' && person.role !== roleFilter) return false;
      if (statusFilter === 'suspended' && !person.banned) return false;
      if (statusFilter === 'active' && person.banned) return false;
      return true;
    });
    if (sortBy === 'messages') {
      list = [...list].sort((a, b) => (b.messageCount || 0) - (a.messageCount || 0));
    } else if (sortBy === 'name') {
      list = [...list].sort((a, b) => a.displayName.localeCompare(b.displayName));
    } else {
      list = [...list].sort((a, b) => b.createdAt - a.createdAt);
    }
    return list;
  }, [users, roleFilter, statusFilter, sortBy]);

  const auditActions = useMemo(() => {
    return [...new Set(logs.map((log) => log.action))].sort((a, b) =>
      (AUDIT_META[a]?.label || a).localeCompare(AUDIT_META[b]?.label || b)
    );
  }, [logs]);

  const filteredLogs = useMemo(() => {
    const needle = auditQuery.trim().toLowerCase();
    return logs.filter((log) => {
      if (auditAction !== 'all' && log.action !== auditAction) return false;
      if (!needle) return true;
      const meta = AUDIT_META[log.action];
      return [
        meta?.label,
        log.action,
        log.detail,
        log.actor.displayName,
        log.actor.username,
        log.targetType,
        String(log.targetId)
      ]
        .join(' ')
        .toLowerCase()
        .includes(needle);
    });
  }, [logs, auditAction, auditQuery]);

  const groupedLogs = useMemo(() => {
    const groups = new Map();
    for (const log of filteredLogs) {
      const label = formatDay(log.createdAt);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(log);
    }
    return [...groups.entries()].map(([label, entries]) => ({ label, logs: entries }));
  }, [filteredLogs]);

  const auditActorCount = useMemo(
    () => new Set(filteredLogs.map((log) => log.actor.username)).size,
    [filteredLogs]
  );
  const auditToday = useMemo(
    () => filteredLogs.filter((log) => formatDay(log.createdAt) === 'Today').length,
    [filteredLogs]
  );

  const onlineRate = overview ? Math.min(100, Math.round((overview.totals.online / Math.max(1, overview.totals.users)) * 100)) : 0;
  const activeRate = overview
    ? Math.min(100, Math.round(((overview.totals.users - overview.totals.banned) / Math.max(1, overview.totals.users)) * 100))
    : 0;
  const badgeRate = overview
    ? Math.min(100, Math.round((overview.totals.badges / Math.max(1, overview.totals.users)) * 100))
    : 0;

  return (
    <div className="admin-page">
      <aside className="admin-sidebar">
        <Link className="admin-brand" to="/">
          <Logo size={30} withText />
          <span className="admin-brand-tag">Control</span>
        </Link>

        <span className="admin-nav-label">Workspace</span>
        <nav className="admin-nav" aria-label="Admin sections">
          {TABS.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.key}
                className={`admin-nav-btn ${tab === item.key ? 'active' : ''}`}
                onClick={() => switchTab(item.key)}
                aria-current={tab === item.key ? 'page' : undefined}
              >
                <Icon size={17} />
                {item.label}
              </button>
            );
          })}
        </nav>

        <div className="admin-sidebar-status">
          <span className="admin-status-dot" />
          <div>
            <strong>All systems nominal</strong>
            <span>
              {overview ? `${overview.totals.online} online / ${overview.totals.users} members` : 'Syncing workspace...'}
            </span>
          </div>
        </div>

        <div className="admin-sidebar-foot">
          <Link className="admin-back-link" to="/">
            <ArrowLeft size={15} /> Back to Cordia
          </Link>
          <div className="admin-identity">
            <Avatar user={user} size={32} showPresence />
            <div>
              <strong>{user.displayName}</strong>
              <span>{user.role === 'admin' ? 'Workspace admin' : 'Member'}</span>
            </div>
            <button className="icon-btn" onClick={logout} title="Sign out" aria-label="Sign out">
              <LogOut size={15} />
            </button>
          </div>
        </div>
      </aside>

      <main className="admin-content">
        <header className="admin-topbar">
          <div className="admin-topbar-copy">
            <span className="admin-eyebrow">
              <span className="admin-eyebrow-dot" /> Control room / {activeTab.label}
            </span>
            <h1>{activeTab.label}</h1>
            <p>{activeTab.blurb}</p>
          </div>
          <div className="admin-actions">
            <span className="admin-live-pill">
              <i /> Live
            </span>
            <span className="admin-topbar-date">{todayLabel}</span>
            <button className="admin-refresh" onClick={refresh} disabled={!!loading}>
              <RefreshCw size={14} className={loading ? 'spin' : ''} /> Refresh
            </button>
          </div>
        </header>

        {error && (
          <div className="admin-error">
            <Ban size={15} /> <span>{error}</span>
            <button onClick={refresh}>Retry</button>
          </div>
        )}

        {tab === 'overview' && (
          <div className="admin-stack">
            {!overview ? (
              <div className="admin-loading">
                <Loader2 className="spin" size={26} />
                <span>{error ? 'Could not load the workspace pulse.' : 'Loading workspace pulse...'}</span>
                {error && (
                  <button className="btn btn-ghost btn-sm" onClick={loadOverview}>
                    Try again
                  </button>
                )}
              </div>
            ) : (
              <>
                <section className="admin-hero">
                  <div className="admin-hero-copy">
                    <span className="admin-hero-kicker">
                      <Zap size={13} /> Workspace pulse
                    </span>
                    <h2>Everything important, without the noise.</h2>
                    <p>
                      Keep an eye on growth, community health, and the moves that keep Cordia running.
                    </p>
                  </div>
                  <div className="admin-hero-stats">
                    <div>
                      <span>Online now</span>
                      <strong>{overview.totals.online}</strong>
                    </div>
                    <div>
                      <span>DM threads</span>
                      <strong>{overview.totals.dms}</strong>
                    </div>
                    <div>
                      <span>Badges</span>
                      <strong>{overview.totals.badges}</strong>
                    </div>
                  </div>
                </section>

                <div className="admin-stat-grid">
                  <StatCard
                    icon={Users}
                    label="Total members"
                    value={overview.totals.users}
                    detail={`${overview.totals.online} online right now`}
                    tone="violet"
                    spark={overview.series.map((day) => day.users)}
                  />
                  <StatCard
                    icon={Server}
                    label="Servers"
                    value={overview.totals.servers}
                    detail={`${overview.recentServers.length} created recently`}
                    tone="sky"
                  />
                  <StatCard
                    icon={MessageSquare}
                    label="Messages"
                    value={overview.totals.messages.toLocaleString()}
                    detail={`${overview.totals.dms} DM conversations`}
                    tone="mint"
                    spark={overview.series.map((day) => day.messages)}
                  />
                  <StatCard
                    icon={Radio}
                    label="Online now"
                    value={overview.totals.online}
                    detail={`${overview.totals.banned} suspended accounts`}
                    tone="amber"
                  />
                </div>

                {activation && (
                  <section className="admin-panel">
                    <div className="admin-panel-head">
                      <div>
                        <span className="admin-panel-kicker">
                          Activation · last {activation.days} days
                        </span>
                        <h3>From signup to first message</h3>
                      </div>
                      <span className="admin-panel-sub">
                        {Math.round(
                          (activation.funnel.firstMessages /
                            Math.max(1, activation.funnel.signups)) *
                            100
                        )}
                        % of new accounts posted something
                      </span>
                    </div>
                    <div className="admin-stat-grid">
                      <StatCard
                        icon={UserRound}
                        label="Signups"
                        value={activation.funnel.signups}
                        detail="new accounts"
                        tone="violet"
                      />
                      <StatCard
                        icon={Server}
                        label="Servers created"
                        value={activation.funnel.servers}
                        detail={`${activation.funnel.invites} invites made`}
                        tone="sky"
                      />
                      <StatCard
                        icon={UserPlus}
                        label="Members joined"
                        value={activation.funnel.joins}
                        detail="through an invite"
                        tone="mint"
                      />
                      <StatCard
                        icon={MessageSquare}
                        label="First messages"
                        value={activation.funnel.firstMessages}
                        detail="accounts that spoke"
                        tone="amber"
                      />
                    </div>
                    <div className="admin-list">
                      <div className="admin-list-row">
                        <div>
                          <strong>Day 1 / Day 7 / Day 30 return</strong>
                          <span>
                            {!activation.retention.cohort
                              ? 'No cohort yet'
                              : activation.retention.d30Eligible
                                ? `${pct(activation.retention.d1, activation.retention.cohort)} / ${pct(
                                    activation.retention.d7,
                                    activation.retention.cohort
                                  )} / ${pct(
                                    activation.retention.d30,
                                    activation.retention.cohort
                                  )} of ${activation.retention.cohort} signups came back`
                                : `Day 1 ${pct(
                                    activation.retention.d1,
                                    activation.retention.cohort
                                  )} · Day 7 ${pct(
                                    activation.retention.d7,
                                    activation.retention.cohort
                                  )} · day 30 in ${activation.retention.d30ReadyInDays ?? 30} days (${
                                    activation.retention.cohort
                                  } signups)`}
                          </span>
                        </div>
                      </div>
                      <div className="admin-list-row">
                        <div>
                          <strong>Time to first message</strong>
                          <span>
                            {activation.timeToValue.medianMinutes === null
                              ? 'Nobody has posted yet'
                              : `median ${formatWait(activation.timeToValue.medianMinutes)} · 90th pct ${formatWait(
                                  activation.timeToValue.p90Minutes ?? activation.timeToValue.medianMinutes
                                )} · ${activation.timeToValue.samples} accounts`}
                          </span>
                        </div>
                      </div>
                      {activation.daily
                          .slice()
                          .reverse()
                          .map((day) => (
                            <div className="admin-list-row" key={day.day}>
                              <div>
                                <strong>{day.day}</strong>
                                <span>
                                  {day.signups} signups · {day.servers} servers · {day.invites}{' '}
                                  invites · {day.joins} joins · {day.firstMessages} first messages
                                </span>
                              </div>
                            </div>
                          ))}
                    </div>
                  </section>
                )}

                <div className="admin-main-grid">
                  <section className="admin-panel admin-chart-panel">
                    <div className="admin-panel-head">
                      <div>
                        <span className="admin-panel-kicker">Last 7 days</span>
                        <h3>Activity pulse</h3>
                      </div>
                      <span className="admin-panel-sub">New members and messages</span>
                    </div>
                    <ActivityChart series={overview.series} />
                  </section>

                  <section className="admin-panel admin-health-panel">
                    <div className="admin-panel-head">
                      <div>
                        <span className="admin-panel-kicker">Signals</span>
                        <h3>Workspace health</h3>
                      </div>
                      <ShieldCheck size={18} className="admin-panel-mark" />
                    </div>
                    <div className="admin-health-list">
                      <div className="admin-health-row">
                        <span className="admin-health-icon mint">
                          <Radio size={16} />
                        </span>
                        <div className="admin-health-copy">
                          <strong>{overview.totals.online} online</strong>
                          <span>{onlineRate}% of the workspace is active</span>
                        </div>
                        <div className="admin-health-meter">
                          <i style={{ width: `${onlineRate}%`, '--health-color': 'var(--teal)' }} />
                        </div>
                      </div>
                      <div className="admin-health-row">
                        <span className="admin-health-icon violet">
                          <Shield size={16} />
                        </span>
                        <div className="admin-health-copy">
                          <strong>{overview.totals.users - overview.totals.banned} active accounts</strong>
                          <span>{overview.totals.banned} suspended</span>
                        </div>
                        <div className="admin-health-meter">
                          <i style={{ width: `${activeRate}%`, '--health-color': 'var(--accent)' }} />
                        </div>
                      </div>
                      <div className="admin-health-row">
                        <span className="admin-health-icon amber">
                          <Sparkles size={16} />
                        </span>
                        <div className="admin-health-copy">
                          <strong>{overview.totals.badges} badges awarded</strong>
                          <span>{badgeRate}% coverage across members</span>
                        </div>
                        <div className="admin-health-meter">
                          <i style={{ width: `${badgeRate}%`, '--health-color': 'var(--amber)' }} />
                        </div>
                      </div>
                    </div>
                    <div className="admin-health-foot">
                      <span>
                        <TrendingUp size={13} /> Growth is measured over the last 7 days
                      </span>
                    </div>
                  </section>
                </div>

                <div className="admin-split-grid">
                  <section className="admin-panel">
                    <div className="admin-panel-head">
                      <div>
                        <span className="admin-panel-kicker">People</span>
                        <h3>Newest members</h3>
                      </div>
                      <button className="link-btn" onClick={() => switchTab('users')}>
                        View all
                      </button>
                    </div>
                    <div className="admin-list">
                      {overview.recentUsers.map((person) => (
                        <div className="admin-list-row" key={person.id}>
                          <Avatar user={person} size={30} showPresence />
                          <div>
                            <strong>{person.displayName}</strong>
                            <span>{person.email}</span>
                          </div>
                          <span className="admin-list-meta">{formatDate(person.createdAt)}</span>
                        </div>
                      ))}
                    </div>
                  </section>

                  <section className="admin-panel">
                    <div className="admin-panel-head">
                      <div>
                        <span className="admin-panel-kicker">Communities</span>
                        <h3>Newest servers</h3>
                      </div>
                      <button className="link-btn" onClick={() => switchTab('servers')}>
                        View all
                      </button>
                    </div>
                    <div className="admin-list">
                      {overview.recentServers.map((server) => (
                        <div className="admin-list-row" key={server.id}>
                          <ServerIcon server={server} className="admin-server-dot" />
                          <div>
                            <strong>{server.name}</strong>
                            <span>@{server.ownerName}</span>
                          </div>
                          <span className="admin-list-meta">{server.memberCount} members</span>
                        </div>
                      ))}
                      {overview.recentServers.length === 0 && (
                        <p className="admin-empty">No servers have been created yet.</p>
                      )}
                    </div>
                  </section>
                </div>
              </>
            )}
          </div>
        )}

        {tab === 'users' && (
          <section className="admin-panel admin-users-panel">
            <div className="admin-panel-head admin-panel-head--toolbar">
              <div>
                <span className="admin-panel-kicker">Directory</span>
                <h3>Members</h3>
                <p className="admin-panel-sub">
                  {visibleUsers.length} of {users.length} accounts / {adminCount} admins / {suspendedCount} suspended
                </p>
              </div>
              <form className="admin-toolbar-search" onSubmit={onSearch}>
                <Search size={15} />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search name, handle or email"
                  aria-label="Search members"
                />
                <button type="submit">Search</button>
              </form>
            </div>

            <div className="admin-filter-row">
              <label className="admin-filter">
                <SlidersHorizontal size={13} />
                <span>Role</span>
                <select value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)}>
                  <option value="all">All roles</option>
                  <option value="admin">Admins</option>
                  <option value="user">Members</option>
                </select>
              </label>
              <label className="admin-filter">
                <span>Status</span>
                <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
                  <option value="all">All status</option>
                  <option value="active">Active</option>
                  <option value="suspended">Suspended</option>
                </select>
              </label>
              <label className="admin-filter">
                <span>Sort</span>
                <select value={sortBy} onChange={(event) => setSortBy(event.target.value)}>
                  <option value="joined">Newest joined</option>
                  <option value="messages">Most messages</option>
                  <option value="name">Name A-Z</option>
                </select>
              </label>
              <button className="admin-filter-reset" onClick={resetUserFilters}>
                Reset filters
              </button>
            </div>

            {loading === 'users' && users.length === 0 ? (
              <div className="admin-loading">
                <Loader2 className="spin" size={24} />
                <span>Loading members...</span>
              </div>
            ) : visibleUsers.length === 0 ? (
              <EmptyState
                icon={Users}
                title="No members match"
                copy="Try a different search or clear the filters to see everyone."
                action="Clear filters"
                onAction={resetUserFilters}
              />
            ) : (
              <div className="admin-table-wrap">
                <table className="admin-table admin-users-table">
                  <thead>
                    <tr>
                      <th>Member</th>
                      <th>Access</th>
                      <th>Badges</th>
                      <th>Footprint</th>
                      <th>Joined</th>
                      <th>Status</th>
                      <th aria-label="Actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {visibleUsers.map((person) => {
                      const self = person.id === user.id;
                      const badgeCount = person.badgeCount || person.badges?.length || 0;
                      return (
                        <tr key={person.id}>
                          <td data-label="Member">
                            <div className="admin-user-cell">
                              <Avatar user={person} size={34} showPresence />
                              <div>
                                <strong>
                                  {person.displayName}
                                  {person.role === 'admin' && (
                                    <span className="admin-mini-role">
                                      <Crown size={10} /> Admin
                                    </span>
                                  )}
                                  {self && <span className="you-tag">you</span>}
                                </strong>
                                <span className="admin-user-meta">
                                  @{person.username} <span className="admin-dot">/</span> {person.email}
                                </span>
                              </div>
                            </div>
                          </td>
                          <td data-label="Access">
                            <select
                              className="admin-role-select"
                              value={person.role}
                              onChange={(event) => changeRole(person, event.target.value)}
                              disabled={self || busy === `role-${person.id}`}
                              aria-label={`Role for ${person.displayName}`}
                            >
                              <option value="user">Member</option>
                              <option value="admin">Admin</option>
                            </select>
                          </td>
                          <td data-label="Badges">
                            <button
                              className="admin-badge-button"
                              onClick={() => setBadgeTarget(person)}
                              title={`Manage badges for ${person.displayName}`}
                            >
                              {badgeCount > 0 ? (
                                <span className="admin-badge-pills">
                                  {[...(person.badges || [])]
                                    .sort((a, b) => badgePriority(a) - badgePriority(b))
                                    .slice(0, 2)
                                    .map((badge) => (
                                      <BadgeChip
                                        key={typeof badge === 'string' ? badge : badge.key}
                                        badge={badge}
                                        size="sm"
                                      />
                                    ))}
                                  {badgeCount > 2 && <span className="admin-badge-more">+{badgeCount - 2}</span>}
                                </span>
                              ) : (
                                <span className="admin-badge-none">No badges</span>
                              )}
                            </button>
                          </td>
                          <td data-label="Footprint">
                            <div className="admin-footprint">
                              <span title="Servers">
                                <Server size={12} /> {person.serverCount}
                              </span>
                              <span title="Messages">
                                <MessageSquare size={12} /> {(person.messageCount || 0).toLocaleString()}
                              </span>
                              <span title="Voice time">
                                <Clock3 size={12} /> {formatDuration(person.voiceSeconds)}
                              </span>
                            </div>
                          </td>
                          <td data-label="Joined">
                            <span className="admin-joined">{formatDate(person.createdAt)}</span>
                          </td>
                          <td data-label="Status">
                            <span className={`status-pill ${person.banned ? 'danger' : 'ok'}`}>
                              <span className="status-dot" />
                              {person.banned ? 'Suspended' : 'Active'}
                            </span>
                          </td>
                          <td data-label="Actions">
                            <div className="admin-row-actions">
                              <button
                                className={`icon-btn ${person.banned ? '' : 'warn-hover'}`}
                                title={person.banned ? 'Restore account' : 'Suspend account'}
                                aria-label={person.banned ? 'Restore account' : 'Suspend account'}
                                disabled={self || busy === `ban-${person.id}`}
                                onClick={() => toggleBan(person)}
                              >
                                {busy === `ban-${person.id}` ? (
                                  <Loader2 size={15} className="spin" />
                                ) : person.banned ? (
                                  <CheckCircle2 size={15} />
                                ) : (
                                  <Ban size={15} />
                                )}
                              </button>
                              <button
                                className="icon-btn danger-hover"
                                title="Delete account"
                                aria-label="Delete account"
                                disabled={self || busy === `delete-${person.id}`}
                                onClick={() => setConfirmDelete(person)}
                              >
                                <Trash2 size={15} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {tab === 'servers' && (
          <section className="admin-panel admin-servers-panel">
            <div className="admin-panel-head">
              <div>
                <span className="admin-panel-kicker">Communities</span>
                <h3>Servers</h3>
                <p className="admin-panel-sub">
                  {servers.length} communities / {servers.reduce((sum, server) => sum + server.memberCount, 0)} total memberships
                </p>
              </div>
              <button className="admin-refresh" onClick={loadServers} disabled={loading === 'servers'}>
                <RefreshCw size={14} className={loading === 'servers' ? 'spin' : ''} /> Reload
              </button>
            </div>
            {loading === 'servers' && servers.length === 0 ? (
              <div className="admin-loading">
                <Loader2 className="spin" size={24} />
                <span>Loading communities...</span>
              </div>
            ) : servers.length === 0 ? (
              <EmptyState icon={Server} title="No servers yet" copy="Communities will appear here once they are created." />
            ) : (
              <div className="admin-server-grid">
                {servers.map((server) => (
                  <article className="admin-server-card" key={server.id}>
                    <div className="admin-server-card-head">
                      <ServerIcon server={server} className="admin-server-avatar" />
                      <div className="admin-server-card-title">
                        <strong>{server.name}</strong>
                        <span>Server #{server.id}</span>
                      </div>
                      <button
                        className="icon-btn danger-hover"
                        title="Delete server"
                        aria-label={`Delete ${server.name}`}
                        disabled={busy === `server-${server.id}`}
                        onClick={() => removeServer(server)}
                      >
                        {busy === `server-${server.id}` ? (
                          <Loader2 size={15} className="spin" />
                        ) : (
                          <Trash2 size={15} />
                        )}
                      </button>
                    </div>
                    <div className="admin-server-card-stats">
                      <span>
                        <Users size={13} /> <strong>{server.memberCount}</strong> members
                      </span>
                      <span>
                        <Hash size={13} /> <strong>{server.channelCount}</strong> channels
                      </span>
                      <span>
                        <MessageSquare size={13} /> <strong>{server.messageCount.toLocaleString()}</strong> messages
                      </span>
                    </div>
                    <div className="admin-server-card-foot">
                      <span>
                        Owned by <strong>@{server.ownerName}</strong>
                      </span>
                      <span>{formatDate(server.createdAt)}</span>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        )}

        {tab === 'safety' && (
          <section className="admin-panel admin-reports-panel">
            <div className="admin-panel-head admin-panel-head--toolbar">
              <div>
                <span className="admin-panel-kicker">Trust & safety</span>
                <h3>Safety signals</h3>
                <p className="admin-panel-sub">
                  {safetyCounts.open} open · {safetyCounts.total} total. Raised automatically — a
                  person still decides.
                </p>
              </div>
              <div className="admin-report-filters">
                {['open', 'reviewed', 'all'].map((status) => (
                  <button
                    key={status}
                    className={`admin-report-filter ${safetyStatus === status ? 'active' : ''}`}
                    onClick={() => setSafetyStatus(status)}
                  >
                    {status[0].toUpperCase() + status.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            {loading === 'safety' && safetyEvents.length === 0 ? (
              <div className="admin-loading">
                <Loader2 className="spin" size={24} />
                <span>Loading signals...</span>
              </div>
            ) : safetyEvents.length === 0 ? (
              <EmptyState
                icon={ShieldAlert}
                title="Nothing raised"
                copy="Spam bursts, mass DMs and predatory DM patterns will appear here."
              />
            ) : (
              <div className="admin-report-list">
                {safetyEvents.map((event) => (
                  <article className="admin-report-card" key={event.id}>
                    <div className="admin-report-card-head">
                      <span
                        className={`admin-report-reason reason-${
                          event.kind === 'predatory_dm' ? 'harassment' : 'spam'
                        }`}
                      >
                        {event.kindLabel}
                      </span>
                      <span
                        className={`admin-report-status status-${
                          event.reviewedAt ? 'resolved' : 'open'
                        }`}
                      >
                        {event.reviewedAt ? 'reviewed' : 'open'}
                      </span>
                      <span className={`admin-safety-severity severity-${event.severity}`}>
                        {event.severity}
                      </span>
                      <time>
                        {formatDate(event.createdAt)} {formatTime(event.createdAt)}
                      </time>
                    </div>

                    <div className="admin-report-meta">
                      <span>
                        Raised on <strong>@{event.user.username}</strong>
                        {event.target ? ` → @${event.target.username}` : ''}
                      </span>
                      <span>
                        {event.scopeType === 'dm'
                          ? 'Direct message'
                          : event.scopeType === 'channel'
                            ? 'Server channel'
                            : 'Workspace'}
                        {event.messageId ? ` / message #${event.messageId}` : ''}
                      </span>
                    </div>

                    {event.excerpt ? (
                      <blockquote className="admin-report-excerpt">{event.excerpt}</blockquote>
                    ) : null}

                    {Array.isArray(event.detail?.flags) && event.detail.flags.length > 0 && (
                      <p className="admin-report-details">Signals: {event.detail.flags.join(', ')}</p>
                    )}
                    {Array.isArray(event.detail?.categories) && event.detail.categories.length > 0 && (
                      <p className="admin-report-details">
                        Patterns: {event.detail.categories.join(', ')}
                      </p>
                    )}

                    <div className="admin-report-card-foot">
                      <span>{event.reviewedAt ? 'Cleared from the queue' : ''}</span>
                      {!event.reviewedAt && (
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => reviewSafety(event)}
                          disabled={safetyBusy === event.id}
                        >
                          {safetyBusy === event.id ? (
                            <Loader2 size={14} className="spin" />
                          ) : (
                            'Mark reviewed'
                          )}
                        </button>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        )}

        {tab === 'reports' && (
          <section className="admin-panel admin-reports-panel">
            <div className="admin-panel-head admin-panel-head--toolbar">
              <div>
                <span className="admin-panel-kicker">Community</span>
                <h3>Message reports</h3>
                <p className="admin-panel-sub">
                  {reports.length} {reportStatus === 'all' ? 'total' : reportStatus} report
                  {reports.length === 1 ? '' : 's'}
                </p>
              </div>
              <div className="admin-report-filters">
                {REPORT_STATUSES.map((status) => (
                  <button
                    key={status}
                    className={`admin-report-filter ${reportStatus === status ? 'active' : ''}`}
                    onClick={() => setReportStatus(status)}
                  >
                    {status === 'all' ? 'All' : status[0].toUpperCase() + status.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            {loading === 'reports' && reports.length === 0 ? (
              <div className="admin-loading">
                <Loader2 className="spin" size={24} />
                <span>Loading reports...</span>
              </div>
            ) : reports.length === 0 ? (
              <EmptyState
                icon={Flag}
                title="No reports here"
                copy="Reported messages will appear in this queue for review."
              />
            ) : (
              <div className="admin-report-list">
                {reports.map((report) => (
                  <article className="admin-report-card" key={report.id}>
                    <div className="admin-report-card-head">
                      <span className={`admin-report-reason reason-${report.reason}`}>
                        {REPORT_REASONS[report.reason] || report.reason}
                      </span>
                      <span className={`admin-report-status status-${report.status}`}>
                        {report.status}
                      </span>
                      {report.encrypted && (
                        <span className="admin-report-encrypted">E2EE evidence</span>
                      )}
                      <time>{formatDate(report.createdAt)} {formatTime(report.createdAt)}</time>
                    </div>

                    <div className="admin-report-meta">
                      <span>
                        Reported <strong>@{report.reportedUser.username}</strong> in{' '}
                        <strong>{report.scopeLabel}</strong>
                      </span>
                      <span>
                        by @{report.reporter.username}
                        {report.messageId ? ` / message #${report.messageId}` : ''}
                      </span>
                    </div>

                    {report.excerpt ? (
                      <blockquote className="admin-report-excerpt">{report.excerpt}</blockquote>
                    ) : (
                      <p className="admin-report-empty-copy">No text content was included.</p>
                    )}

                    {report.details && (
                      <p className="admin-report-details">Reporter note: {report.details}</p>
                    )}

                    <div className="admin-report-card-foot">
                      <span>
                        {report.attachmentName ? `Attachment: ${report.attachmentName}` : ''}
                        {report.actionTaken ? ` / Action: ${report.actionTaken}` : ''}
                      </span>
                      <button className="btn btn-ghost btn-sm" onClick={() => setReportTarget(report)}>
                        Review
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        )}

        {tab === 'mail' && (
          <section className="admin-panel admin-mail-panel">
            <div className="admin-panel-head admin-panel-head--toolbar">
              <div>
                <span className="admin-panel-kicker">Delivery</span>
                <h3>Email</h3>
                <p className="admin-panel-sub">
                  {mail
                    ? `${mail.pending} queued / ${mail.sent} sent / ${mail.failed} failed`
                    : 'Loading delivery state...'}
                </p>
              </div>
              <button className="admin-refresh" onClick={loadMail} disabled={loading === 'mail'}>
                <RefreshCw size={15} className={loading === 'mail' ? 'spin' : ''} />
                Refresh
              </button>
            </div>

            {mailError && <div className="form-error">{mailError}</div>}

            <div className="admin-mail-status">
              <div className={`admin-mail-chip ${mail && mail.transport && mail.transport.ok ? 'is-ok' : 'is-bad'}`}>
                <span className="admin-mail-dot" />
                {mail && mail.transport
                  ? mail.transport.ok
                    ? `SMTP reachable · ${mail.transport.detail}`
                    : `SMTP unreachable · ${mail.transport.detail}`
                  : 'Checking transport...'}
              </div>
              {mail && mail.origin && <div className="admin-mail-chip">Links point at {mail.origin}</div>}
            </div>

            <form className="admin-mail-compose" onSubmit={sendBroadcast}>
              <label className="field">
                <span>Subject</span>
                <input
                  value={broadcast.subject}
                  onChange={(event) => setBroadcast((prev) => ({ ...prev, subject: event.target.value }))}
                  placeholder="What is new in Cordia"
                  maxLength={160}
                  required
                />
              </label>
              <label className="field">
                <span>Message</span>
                <textarea
                  value={broadcast.message}
                  onChange={(event) => setBroadcast((prev) => ({ ...prev, message: event.target.value }))}
                  placeholder="Write it the way you would say it. Blank lines become paragraphs."
                  rows={7}
                  maxLength={8000}
                  required
                />
              </label>

              <div className="admin-mail-segments">
                {[
                  ['verified', 'Confirmed addresses', 'Only people who clicked the link'],
                  ['everyone', 'Everyone', 'Includes unconfirmed addresses'],
                  ['admins', 'Admins only', 'A test send that reaches a handful']
                ].map(([key, label, hint]) => (
                  <button
                    type="button"
                    key={key}
                    className={`admin-mail-segment ${broadcast.segment === key ? 'active' : ''}`}
                    onClick={() => previewBroadcast(key)}
                  >
                    <strong>{label}</strong>
                    <span>{hint}</span>
                  </button>
                ))}
              </div>

              <div className="admin-mail-foot">
                <span>
                  {broadcastCount == null
                    ? 'Pick a segment to see how many people this reaches.'
                    : broadcastCount === 0
                      ? 'Nobody in this segment yet — try another one.'
                      : `${broadcastCount} recipient${broadcastCount === 1 ? '' : 's'}`}
                </span>
                <button
                  className="btn btn-primary"
                  disabled={broadcastBusy === 'send' || broadcastCount === 0}
                >
                  {broadcastBusy === 'send' ? <Loader2 size={16} className="spin" /> : <MailCheck size={16} />}
                  Queue broadcast
                </button>
              </div>
            </form>

            {mail && mail.recent && mail.recent.length > 0 && (
              <div className="admin-mail-recent">
                <span className="admin-panel-kicker">Last 25 messages</span>
                <div className="admin-list">
                  {mail.recent.map((row) => (
                    <div className="admin-list-row" key={row.id}>
                      <div className="admin-mail-recent-main">
                        <strong>{row.subject}</strong>
                        <span className="admin-list-meta">
                          {row.to} · {row.kind}
                          {row.error ? ` · ${row.error}` : ''}
                        </span>
                      </div>
                      <span
                        className={`admin-mail-tag ${row.sentAt ? 'is-ok' : row.failedAt ? 'is-bad' : 'is-wait'}`}
                      >
                        {row.sentAt ? 'sent' : row.failedAt ? 'failed' : 'queued'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}

        {tab === 'audit' && (
          <section className="admin-panel admin-audit-panel">
            <div className="admin-panel-head admin-panel-head--toolbar">
              <div>
                <span className="admin-panel-kicker">Trace</span>
                <h3>Audit log</h3>
                <p className="admin-panel-sub">
                  {filteredLogs.length} of {logs.length} events / {auditActorCount} actors / {auditToday} today
                </p>
              </div>
              <div className="admin-audit-summary">
                <span>
                  <Activity size={12} /> Latest {logs[0] ? formatTime(logs[0].createdAt) : '--'}
                </span>
                <span>
                  <ShieldCheck size={12} /> Last 100 actions
                </span>
              </div>
            </div>

            <div className="admin-filter-row">
              <form className="admin-toolbar-search admin-toolbar-search--audit" onSubmit={(event) => event.preventDefault()}>
                <Search size={15} />
                <input
                  value={auditQuery}
                  onChange={(event) => setAuditQuery(event.target.value)}
                  placeholder="Search actor, action or detail"
                  aria-label="Search audit log"
                />
              </form>
              <label className="admin-filter">
                <span>Action</span>
                <select value={auditAction} onChange={(event) => setAuditAction(event.target.value)}>
                  <option value="all">All actions</option>
                  {auditActions.map((action) => (
                    <option value={action} key={action}>
                      {AUDIT_META[action]?.label || action}
                    </option>
                  ))}
                </select>
              </label>
              <button className="admin-filter-reset" onClick={resetAuditFilters}>
                Clear filters
              </button>
            </div>

            {loading === 'audit' && logs.length === 0 ? (
              <div className="admin-loading">
                <Loader2 className="spin" size={24} />
                <span>Loading audit events...</span>
              </div>
            ) : filteredLogs.length === 0 ? (
              <EmptyState
                icon={ScrollText}
                title="No audit events match"
                copy="Try a different search or clear the filters to see the full trace."
                action="Clear filters"
                onAction={resetAuditFilters}
              />
            ) : (
              <div className="admin-audit-groups">
                {groupedLogs.map((group) => (
                  <div className="admin-audit-group" key={group.label}>
                    <div className="admin-audit-day">
                      <span>{group.label}</span>
                      <span>{group.logs.length} events</span>
                    </div>
                    <div className="admin-audit-list">
                      {group.logs.map((log) => {
                        const meta = AUDIT_META[log.action] || {
                          label: log.action,
                          color: '#94a3b8',
                          icon: Activity
                        };
                        const Icon = meta.icon;
                        return (
                          <div className="admin-audit-item" key={log.id}>
                            <span className="admin-audit-icon" style={{ '--audit-color': meta.color }}>
                              <Icon size={15} />
                            </span>
                            <div className="admin-audit-copy">
                              <div className="admin-audit-title">
                                <strong>{meta.label}</strong>
                                <span className="admin-audit-target">
                                  {log.targetType} #{log.targetId}
                                </span>
                              </div>
                              <p>{log.detail || 'No additional detail'}</p>
                              <span className="admin-audit-actor">
                                by {log.actor.displayName} <span>@{log.actor.username}</span>
                              </span>
                            </div>
                            <time className="admin-audit-time" dateTime={new Date(log.createdAt).toISOString()}>
                              {formatTime(log.createdAt)}
                            </time>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      </main>

      {reportTarget && (
        <ReportReviewModal
          report={reportTarget}
          onClose={() => setReportTarget(null)}
          onSave={saveReportReview}
        />
      )}

      {badgeTarget && (
        <BadgesModal
          target={badgeTarget}
          onClose={() => setBadgeTarget(null)}
          onChanged={updateBadges}
          notify={notify}
        />
      )}

      {confirmDelete && (
        <Modal
          title={`Delete ${confirmDelete.displayName}?`}
          subtitle="This cannot be undone."
          onClose={() => setConfirmDelete(null)}
          width={440}
          footer={
            <div className="settings-footer-right">
              <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(null)}>
                Cancel
              </button>
              <button
                className="btn btn-danger btn-sm"
                onClick={() => removeUser(confirmDelete)}
                disabled={busy === `delete-${confirmDelete.id}`}
              >
                {busy === `delete-${confirmDelete.id}` ? (
                  <Loader2 size={14} className="spin" />
                ) : (
                  <Trash2 size={14} />
                )}
                Delete account
              </button>
            </div>
          }
        >
          <p className="admin-confirm-copy">
            {confirmDelete.displayName} will lose access immediately. Their messages, reactions, friendships
            and server memberships are removed as well. Servers they own are deleted for everyone.
          </p>
        </Modal>
      )}

      <Toast toast={notice} />
    </div>
  );
}
