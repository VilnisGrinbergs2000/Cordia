import { useEffect, useState } from 'react';
import { Check, CreditCard, Loader2, Plus, Sparkles, Trash2 } from 'lucide-react';
import api from '../api';

function money(cents, interval) {
  const amount = (Number(cents) || 0) / 100;
  return `$${amount.toFixed(amount % 1 === 0 ? 0 : 2)} / ${interval === 'year' ? 'year' : 'month'}`;
}

const BLANK = { name: '', description: '', priceCents: 300, interval: 'month', color: '#f59e0b', groupId: '' };

export default function ServerTiersPanel({ server, canManage, onUpdated }) {
  const [tiers, setTiers] = useState(null);
  const [subscription, setSubscription] = useState(null);
  const [summary, setSummary] = useState(null);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let cancelled = false;
    api
      .get(`/api/servers/${server.id}/tiers`)
      .then((data) => {
        if (cancelled) return;
        setTiers(data.tiers || []);
        setSubscription(data.subscription || null);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [server.id]);

  useEffect(() => {
    if (!canManage) return undefined;
    let cancelled = false;
    api
      .get(`/api/servers/${server.id}/tiers/summary`)
      .then((data) => {
        if (!cancelled) setSummary(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [server.id, canManage, tiers]);

  async function run(name, action) {
    setBusy(name);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  function subscribe(tier) {
    run(`subscribe-${tier.id}`, async () => {
      const data = await api.post(`/api/servers/${server.id}/tiers/${tier.id}/subscribe`, {});
      setSubscription(data.subscription);
      onUpdated?.(data.server);
      setNotice(`You are now supporting this server with ${tier.name}.`);
      const refreshed = await api.get(`/api/servers/${server.id}/tiers`);
      setTiers(refreshed.tiers || []);
    });
  }

  function cancel() {
    if (!subscription) return;
    run('cancel', async () => {
      const data = await api.del(`/api/servers/${server.id}/tiers/${subscription.tierId}/subscribe`);
      setSubscription(null);
      onUpdated?.(data.server);
      setNotice('Your subscription is canceled.');
      const refreshed = await api.get(`/api/servers/${server.id}/tiers`);
      setTiers(refreshed.tiers || []);
    });
  }

  function saveTier() {
    if (!draft) return;
    run('save', async () => {
      const body = {
        name: draft.name,
        description: draft.description,
        priceCents: Number(draft.priceCents),
        interval: draft.interval,
        color: draft.color,
        groupId: draft.groupId ? Number(draft.groupId) : null
      };
      const data = draft.id
        ? await api.patch(`/api/servers/${server.id}/tiers/${draft.id}`, body)
        : await api.post(`/api/servers/${server.id}/tiers`, body);
      setTiers(data.tiers || []);
      setDraft(null);
      setNotice('Tier saved.');
    });
  }

  function deleteTier(tier) {
    if (!window.confirm(`Delete the ${tier.name} tier? Subscribers lose it immediately.`)) return;
    run(`delete-${tier.id}`, async () => {
      const data = await api.del(`/api/servers/${server.id}/tiers/${tier.id}`);
      setTiers(data.tiers || []);
    });
  }

  const roles = (server.groups || []).filter((group) => !group.isDefault);

  return (
    <div className="server-settings">
      <div className="settings-section-head">
        <div>
          <h3>Server subscriptions</h3>
          <p>
            Any server can sell supporter tiers here. Paying grants the role you pick, and
            canceling takes it back - no partner programme, no follower count, no gate.
          </p>
        </div>
        {canManage && !draft && (
          <button className="btn btn-primary btn-sm" onClick={() => setDraft({ ...BLANK })}>
            <Plus size={15} /> New tier
          </button>
        )}
      </div>

      {error && <div className="form-error">{error}</div>}
      {notice && <div className="tier-notice">{notice}</div>}

      {canManage && summary && (
        <div className="tier-summary">
          <div className="tier-stat">
            <strong>{summary.subscribers}</strong>
            <span>subscribers</span>
          </div>
          <div className="tier-stat">
            <strong>{'$' + (summary.monthlyCents / 100).toFixed(2)}</strong>
            <span>per month</span>
          </div>
        </div>
      )}

      {draft && (
        <div className="tier-editor">
          <label className="field">
            <span>Name</span>
            <input
              value={draft.name}
              maxLength={40}
              placeholder="Supporter"
              onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))}
            />
          </label>
          <label className="field">
            <span>Description</span>
            <textarea
              value={draft.description}
              maxLength={300}
              rows={2}
              placeholder="What supporters get."
              onChange={(event) =>
                setDraft((prev) => ({ ...prev, description: event.target.value }))
              }
            />
          </label>
          <div className="tier-editor-row">
            <label className="field">
              <span>Price (cents)</span>
              <input
                type="number"
                min="50"
                max="500000"
                value={draft.priceCents}
                onChange={(event) =>
                  setDraft((prev) => ({ ...prev, priceCents: event.target.value }))
                }
              />
            </label>
            <label className="field">
              <span>Billing</span>
              <select
                value={draft.interval}
                onChange={(event) => setDraft((prev) => ({ ...prev, interval: event.target.value }))}
              >
                <option value="month">Monthly</option>
                <option value="year">Yearly</option>
              </select>
            </label>
            <label className="field">
              <span>Role granted</span>
              <select
                value={draft.groupId || ''}
                onChange={(event) => setDraft((prev) => ({ ...prev, groupId: event.target.value }))}
              >
                <option value="">No role</option>
                {roles.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="tier-editor-actions">
            <button className="btn ghost small" onClick={() => setDraft(null)}>
              Cancel
            </button>
            <button className="btn btn-primary btn-sm" onClick={saveTier} disabled={busy === 'save'}>
              {busy === 'save' ? <Loader2 size={14} className="spin" /> : 'Save tier'}
            </button>
          </div>
        </div>
      )}

      {tiers === null && <p className="channel-empty">Loading tiers...</p>}
      {tiers && tiers.length === 0 && (
        <p className="channel-empty">
          <Sparkles size={16} /> No tiers yet.
          {canManage ? ' Create one to start taking subscriptions.' : ''}
        </p>
      )}

      <div className="tier-grid">
        {(tiers || []).map((tier) => {
          const active = subscription?.tierId === tier.id;
          return (
            <div className={`tier-card ${active ? 'active' : ''}`} key={tier.id}>
              <div className="tier-card-head">
                <span className="tier-dot" style={{ background: tier.color }} />
                <strong>{tier.name}</strong>
                {active && (
                  <span className="tier-active-tag">
                    <Check size={12} /> Yours
                  </span>
                )}
              </div>
              <div className="tier-price">{money(tier.priceCents, tier.interval)}</div>
              {tier.description && <p className="tier-desc">{tier.description}</p>}
              <div className="tier-card-foot">
                <span className="tier-count">
                  {tier.subscribers || 0} {tier.subscribers === 1 ? 'supporter' : 'supporters'}
                </span>
                <div className="tier-card-actions">
                  {canManage && (
                    <>
                      <button
                        className="icon-btn"
                        title={`Edit ${tier.name}`}
                        onClick={() => setDraft({ ...tier, groupId: tier.groupId || '' })}
                      >
                        <CreditCard size={14} />
                      </button>
                      <button
                        className="icon-btn danger-hover"
                        title={`Delete ${tier.name}`}
                        onClick={() => deleteTier(tier)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </>
                  )}
                  {active ? (
                    <button className="btn ghost small" onClick={cancel} disabled={busy === 'cancel'}>
                      {busy === 'cancel' ? <Loader2 size={14} className="spin" /> : 'Cancel'}
                    </button>
                  ) : (
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => subscribe(tier)}
                      disabled={busy === `subscribe-${tier.id}`}
                    >
                      {busy === `subscribe-${tier.id}` ? (
                        <Loader2 size={14} className="spin" />
                      ) : (
                        'Subscribe'
                      )}
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
