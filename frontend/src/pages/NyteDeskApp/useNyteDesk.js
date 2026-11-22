import { useCallback, useEffect, useRef, useState } from "react";
import NyteDesk from "@/models/nytedesk";
import { createSequencer } from "@/utils/nytedesk/taskState";
import {
  DATA_REFRESH_MS,
  FOCUS_REFRESH_MIN_MS,
  createSingleFlight,
} from "@/utils/nytedesk/layout";

const TELEMETRY_INTERVAL_MS = 10_000;
const CLOCK_INTERVAL_MS = 5_000;
const TELEMETRY_ROLES = ["admin", "manager"];

/**
 * Everything the dashboard shows, from the NyteDesk API only. Nothing here is
 * estimated: a value the server did not return stays null and is rendered as
 * unavailable.
 *
 * Refresh: tasks, approvals and engines reload every DATA_REFRESH_MS while the
 * page is visible and when the window regains focus (at most once per
 * FOCUS_REFRESH_MIN_MS); runs never overlap. A failed refresh keeps the last
 * good data and reports the failure. Host telemetry is polled only for roles
 * the server allows (managers and administrators).
 *
 * Lifecycle: every data and telemetry request takes a token from its own
 * sequencer, and only the newest token may update state. Unmounting cancels
 * both sequencers, so a response that arrives later changes nothing.
 */
export default function useNyteDesk(role) {
  const [state, setState] = useState({
    loading: true,
    status: null,
    error: null,
    components: [],
    engines: null,
    tasks: [],
    approvals: [],
    workspaces: [],
  });
  const [sync, setSync] = useState({
    lastSuccessAt: null,
    lastError: null,
    refreshing: false,
  });
  const [telemetry, setTelemetry] = useState(null);
  const [telemetryError, setTelemetryError] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  const lastAttempt = useRef(0);
  const dataSeq = useRef(null);
  const telemetrySeq = useRef(null);
  const singleFlight = useRef(null);

  // Lifecycle (declared first, so it runs before the effects that fetch):
  // fresh sequencers on mount; on unmount they are cancelled and the shared
  // in-flight refresh is dropped. Safe under StrictMode's mount/unmount/mount.
  useEffect(() => {
    dataSeq.current = createSequencer();
    telemetrySeq.current = createSequencer();
    return () => {
      dataSeq.current.cancel();
      telemetrySeq.current.cancel();
      singleFlight.current = null;
    };
  }, []);

  const load = useCallback(async () => {
    const seq = dataSeq.current;
    if (!seq) return;
    const token = seq.begin();
    lastAttempt.current = Date.now();
    setSync((prev) => ({ ...prev, refreshing: true }));
    const s = await NyteDesk.status();
    if (!seq.isCurrent(token)) return;
    if (!s.ok || !s.data.enabled || !s.data.multiUser) {
      setState((prev) => ({
        ...prev,
        loading: false,
        status: s.ok ? s.data : prev.status,
        error: s.ok ? null : s.error,
      }));
      setSync((prev) => ({
        lastSuccessAt: s.ok ? new Date().toISOString() : prev.lastSuccessAt,
        lastError: s.ok ? null : s.error,
        refreshing: false,
      }));
      return;
    }
    const [a, e, t, p, w] = await Promise.all([
      NyteDesk.agents(),
      NyteDesk.engines(),
      NyteDesk.tasks({ limit: 100 }),
      NyteDesk.approvals(),
      NyteDesk.workspaces(),
    ]);
    if (!seq.isCurrent(token)) return;
    const firstError = [a, e, t, p, w].find((r) => !r.ok)?.error ?? null;
    // Keep the last good value of anything that failed this time.
    setState((prev) => ({
      loading: false,
      status: s.data,
      error: firstError,
      components: a.ok ? a.data.components || [] : prev.components,
      engines: e.ok ? e.data : prev.engines,
      tasks: t.ok ? t.data.tasks || [] : prev.tasks,
      approvals: p.ok ? p.data.approvals || [] : prev.approvals,
      workspaces: w.ok ? w.data.workspaces || [] : prev.workspaces,
    }));
    setSync((prev) => ({
      lastSuccessAt: firstError ? prev.lastSuccessAt : new Date().toISOString(),
      lastError: firstError,
      refreshing: false,
    }));
  }, []);

  const refresh = useCallback(() => {
    if (!singleFlight.current) singleFlight.current = createSingleFlight(load);
    return singleFlight.current();
  }, [load]);

  useEffect(() => {
    refresh();
    const tick = () => {
      if (!document.hidden) refresh();
    };
    const id = setInterval(tick, DATA_REFRESH_MS);
    const onFocus = () => {
      if (document.hidden) return;
      if (Date.now() - lastAttempt.current < FOCUS_REFRESH_MIN_MS) return;
      refresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [refresh]);

  const pollTelemetry = useCallback(async () => {
    if (typeof document !== "undefined" && document.hidden) return;
    const seq = telemetrySeq.current;
    if (!seq) return;
    const token = seq.begin();
    const r = await NyteDesk.telemetry();
    if (!seq.isCurrent(token)) return;
    if (r.ok) {
      setTelemetry(r.data.telemetry);
      setTelemetryError(null);
    } else {
      setTelemetryError(r.error);
    }
  }, []);

  const ready = !!(state.status?.enabled && state.status?.multiUser);
  const telemetryAllowed = TELEMETRY_ROLES.includes(role);
  useEffect(() => {
    if (!ready || !telemetryAllowed) return undefined;
    pollTelemetry();
    const id = setInterval(pollTelemetry, TELEMETRY_INTERVAL_MS);
    return () => clearInterval(id);
  }, [ready, telemetryAllowed, pollTelemetry]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), CLOCK_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  return {
    ...state,
    ready,
    sync,
    telemetry,
    telemetryError,
    telemetryAllowed,
    now,
    refresh,
  };
}
