import { useCallback, useEffect, useState } from "react";
import NyteDesk from "@/models/nytedesk";

const TELEMETRY_INTERVAL_MS = 10_000;
const CLOCK_INTERVAL_MS = 5_000;

/**
 * Everything the dashboard shows, from the NyteDesk API only. Nothing here is
 * estimated: a value the server did not return stays null and is rendered as
 * unavailable. Telemetry is polled while the page is visible.
 */
export default function useNyteDesk() {
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
  const [telemetry, setTelemetry] = useState(null);
  const [telemetryError, setTelemetryError] = useState(null);
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    const s = await NyteDesk.status();
    if (!s.ok || !s.data.enabled || !s.data.multiUser) {
      setState((prev) => ({
        ...prev,
        loading: false,
        status: s.ok ? s.data : null,
        error: s.ok ? null : s.error,
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
    const firstError = [a, e, t, p, w].find((r) => !r.ok)?.error ?? null;
    setState({
      loading: false,
      status: s.data,
      error: firstError,
      components: a.data.components || [],
      engines: e.ok ? e.data : null,
      tasks: t.data.tasks || [],
      approvals: p.data.approvals || [],
      workspaces: w.data.workspaces || [],
    });
  }, []);

  const pollTelemetry = useCallback(async () => {
    if (typeof document !== "undefined" && document.hidden) return;
    const r = await NyteDesk.telemetry();
    if (r.ok) {
      setTelemetry(r.data.telemetry);
      setTelemetryError(null);
    } else {
      setTelemetryError(r.error);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const ready = !!(state.status?.enabled && state.status?.multiUser);
  useEffect(() => {
    if (!ready) return undefined;
    pollTelemetry();
    const id = setInterval(pollTelemetry, TELEMETRY_INTERVAL_MS);
    return () => clearInterval(id);
  }, [ready, pollTelemetry]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), CLOCK_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  return { ...state, ready, telemetry, telemetryError, now, refresh };
}
