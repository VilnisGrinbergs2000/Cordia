import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import {
  deltaLabel,
  shortDay,
  sinceLabel,
  sparkPeak,
  sparkPoints,
  sparkX,
  sparkY
} from '../insightsChart';

const RANGES = [7, 14, 30];

// One card, two homes: the settings overview (compact) and /insights (expanded).
// It owns its own fetch so neither caller has to know the endpoint.
export default function InsightsCard({ serverId, expanded = false }) {
  const [data, setData] = useState(null);
  const [range, setRange] = useState(14);
  const [hover, setHover] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!serverId) return undefined;
    let cancelled = false;
    api
      .get(`/api/servers/${serverId}/insights?days=${range}`)
      .then((payload) => {
        if (!cancelled) setData(payload);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Could not load insights.');
      });
    return () => {
      cancelled = true;
    };
  }, [serverId, range]);

  const series = data?.daily || [];
  const peak = series.length ? sparkPeak(series) : 1;
  const pointed = hover !== null && series[hover] ? series[hover] : null;

  // Mouse and touch share the same math; only the event shape differs.
  function trackPointer(event) {
    if (!series.length) return;
    const point = event.touches?.[0] || event;
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width) return;
    const ratio = (point.clientX - rect.left) / rect.width;
    const index = Math.round(ratio * (series.length - 1));
    setHover(Math.min(series.length - 1, Math.max(0, index)));
  }

  // Keyboard parity: the chart is focusable, arrows walk the days, and the
  // readout is the live region that announces them.
  function onKeyDown(event) {
    if (!series.length) return;
    const last = series.length - 1;
    if (event.key === 'ArrowRight') {
      setHover((current) => Math.min(last, current === null ? 0 : current + 1));
      event.preventDefault();
    } else if (event.key === 'ArrowLeft') {
      setHover((current) => Math.max(0, current === null ? last : current - 1));
      event.preventDefault();
    } else if (event.key === 'Home') {
      setHover(0);
      event.preventDefault();
    } else if (event.key === 'End') {
      setHover(last);
      event.preventDefault();
    }
  }

  function pickRange(value) {
    setRange(value);
    setHover(null);
  }

  return (
    <div className={`settings-access-card insights-card${expanded ? ' insights-card--wide' : ''}`} data-settings-focus="insights">
      <div className="insights-body">
        {error && <p className="field-hint">{error}</p>}
        <div className="insights-head">
          <span className="settings-label">Last {data?.days || range} days</span>
          <div className="insights-head-right">
            {!expanded && (
              <Link className="insights-link" to={`/insights/${serverId}`}>
                Full view
              </Link>
            )}
            <div className="insights-range" role="group" aria-label="Insights range">
              {RANGES.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={range === value ? 'active' : ''}
                  aria-pressed={range === value}
                  onClick={() => pickRange(value)}
                >
                  {value}d
                </button>
              ))}
            </div>
          </div>
        </div>
        {series.length > 1 && (
          <div
            className={`insights-chart${expanded ? ' insights-chart--tall' : ''}`}
            tabIndex={0}
            role="group"
            aria-label={`Messages per day over the last ${data.days} days. Use the arrow keys to read a day.`}
            onMouseMove={trackPointer}
            onMouseLeave={() => setHover(null)}
            onTouchStart={trackPointer}
            onTouchMove={trackPointer}
            onTouchEnd={() => setHover(null)}
            onKeyDown={onKeyDown}
            onFocus={() => setHover((current) => (current === null ? series.length - 1 : current))}
            onBlur={() => setHover(null)}
          >
            {/* The plot is stretched to the card, so a marker drawn inside the
                SVG would stretch with it and turn into a wide ellipse. The dot
                is an HTML element placed by percentage instead, which keeps it
                round at any size. */}
            <div className="insights-plot">
              <svg
                className="insights-spark"
                viewBox="0 0 100 28"
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                <line className="insights-grid" x1="0" y1="2" x2="100" y2="2" vectorEffect="non-scaling-stroke" />
                <polyline points={sparkPoints(series)} vectorEffect="non-scaling-stroke" />
              </svg>
              {pointed && (
                <span
                  className="insights-dot"
                  style={{
                    left: `${sparkX(series, hover)}%`,
                    top: `${(Number(sparkY(series, hover)) / 28) * 100}%`
                  }}
                />
              )}
            </div>
            <span className="insights-spark-label" aria-live="polite">
              {pointed
                ? `${shortDay(pointed.day)} · ${pointed.messages} messages`
                : 'messages per day'}
              {' · '}
              <em className="insights-peak">peak {peak}</em>
            </span>
          </div>
        )}
        <div className="insights-stats">
          <div>
            <strong>{data ? data.joins : '--'}</strong>
            <span>{data?.joins === 1 ? 'new member' : 'new members'}</span>
            {data && <em className="insights-delta">{deltaLabel(data.joins, data.joinsPrev)}</em>}
          </div>
          <div>
            <strong>{data ? data.messages : '--'}</strong>
            <span>messages</span>
            {data && (
              <em className="insights-delta">{deltaLabel(data.messages, data.messagesPrev)}</em>
            )}
          </div>
          <div>
            <strong>{data ? data.active : '--'}</strong>
            <span>{data?.active === 1 ? 'person talking' : 'people talking'}</span>
          </div>
        </div>
        {data?.channels?.length > 0 && (
          <p className="insights-channels">
            Busiest:
            {data.channels.map((entry, index) => (
              <span key={entry.id}>
                {index > 0 ? ', ' : ' '}#{entry.name}
                {' '}<em>{entry.messages}</em>
              </span>
            ))}
          </p>
        )}
        {data?.lastMessageAt && (
          <p className="insights-channels">Last message {sinceLabel(data.lastMessageAt)}</p>
        )}
        {data && data.messages === 0 && (
          <p className="field-hint">
            Nobody has posted yet. A scheduled event or a pinned prompt is the usual way to
            get the first conversation going.
          </p>
        )}
      </div>
    </div>
  );
}
