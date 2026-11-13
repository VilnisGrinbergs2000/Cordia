import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import api from './api';

// The server sends these, but the fallback has to be the same numbers: a failed
// request must not quietly change the upload ceiling or the storage meter.
export const ACCOUNT_LIMITS = {
  maxUploadBytes: 50 * 1024 * 1024,
  storageQuotaBytes: 5 * 1024 * 1024 * 1024
};

const EMPTY_STATE = {
  limits: ACCOUNT_LIMITS,
  storage: { used: 0, quota: ACCOUNT_LIMITS.storageQuotaBytes, percent: 0 },
  loading: true,
  error: ''
};

const SupportContext = createContext(null);

export function SupportProvider({ children }) {
  const [state, setState] = useState(EMPTY_STATE);
  const ticket = useRef(0);

  // One request answers both questions the UI has - what the limits are and
  // how much of them is spent - so the meter and the composer cannot disagree.
  const refresh = useCallback(async () => {
    const id = ++ticket.current;
    setState((prev) => ({ ...prev, loading: true }));
    try {
      const payload = await api.get('/api/support/me');
      if (id !== ticket.current) return null;
      const next = {
        limits: { ...ACCOUNT_LIMITS, ...(payload?.limits || {}) },
        storage: { ...EMPTY_STATE.storage, ...(payload?.storage || {}) },
        loading: false,
        error: ''
      };
      setState(next);
      return next;
    } catch (err) {
      if (id !== ticket.current) return null;
      setState((prev) => ({
        ...prev,
        loading: false,
        error: err.message || 'Could not load your storage.'
      }));
      return null;
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const value = useMemo(() => ({ ...state, refresh }), [state, refresh]);
  return <SupportContext.Provider value={value}>{children}</SupportContext.Provider>;
}

export function useSupport() {
  const ctx = useContext(SupportContext);
  if (!ctx) throw new Error('useSupport must be used inside a SupportProvider');
  return ctx;
}
