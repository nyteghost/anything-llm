// NyteDesk dashboard layout preferences: collapsed navigation and the width of
// the right sidebar. The chat panel takes the remaining width.
export const LAYOUT_KEY = "nytedesk_layout_v1";
export const RIGHT_MIN = 260;
export const RIGHT_MAX = 520;
export const RIGHT_DEFAULT = 320;
export const MAIN_MIN = 420;
export const NAV_EXPANDED = 232;
export const NAV_COLLAPSED = 64;

export const DEFAULT_LAYOUT = Object.freeze({
  navCollapsed: false,
  rightWidth: RIGHT_DEFAULT,
});

/** Right width within limits, leaving at least MAIN_MIN for the chat. */
export function clampRightWidth(width, available = Infinity) {
  const n = Number(width);
  const value = Number.isFinite(n) ? Math.round(n) : RIGHT_DEFAULT;
  const roomForMain = Number.isFinite(available)
    ? available - MAIN_MIN
    : RIGHT_MAX;
  const max = Math.max(RIGHT_MIN, Math.min(RIGHT_MAX, roomForMain));
  return Math.min(Math.max(value, RIGHT_MIN), max);
}

export function readLayout(storage = globalThis.localStorage) {
  try {
    const raw = JSON.parse(storage.getItem(LAYOUT_KEY) || "null");
    if (!raw || typeof raw !== "object") return { ...DEFAULT_LAYOUT };
    return {
      navCollapsed: raw.navCollapsed === true,
      rightWidth: clampRightWidth(raw.rightWidth),
    };
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

export function writeLayout(layout, storage = globalThis.localStorage) {
  const value = {
    navCollapsed: layout.navCollapsed === true,
    rightWidth: clampRightWidth(layout.rightWidth),
  };
  try {
    storage.setItem(LAYOUT_KEY, JSON.stringify(value));
  } catch {
    // Storage blocked: the layout still works for this session.
  }
  return value;
}

/** Freshness of a telemetry sample, for "Updated Ns ago" and stale marking. */
export function freshness(sampledAt, now = Date.now(), staleAfterMs = 30_000) {
  const t = Date.parse(sampledAt);
  if (!Number.isFinite(t))
    return { ageMs: null, stale: true, label: "No sample" };
  const ageMs = Math.max(0, now - t);
  const s = Math.round(ageMs / 1000);
  const label = s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
  return { ageMs, stale: ageMs > staleAfterMs, label };
}

export const DATA_REFRESH_MS = 30_000;
export const DATA_STALE_MS = 90_000;
export const FOCUS_REFRESH_MIN_MS = 5_000;

/**
 * Wraps an async function so overlapping calls share one run: a call made
 * while a run is in flight gets that run's promise instead of starting another.
 */
export function createSingleFlight(fn) {
  let running = null;
  return () => {
    if (!running) {
      running = Promise.resolve()
        .then(fn)
        .finally(() => {
          running = null;
        });
    }
    return running;
  };
}

/**
 * State of the dashboard data for the freshness indicator: loading (nothing
 * yet), refreshing, failed (last attempt failed; older data may be shown),
 * stale (last success older than DATA_STALE_MS) or fresh.
 */
export function dataFreshness(
  { lastSuccessAt = null, lastError = null, refreshing = false } = {},
  now = Date.now(),
  staleAfterMs = DATA_STALE_MS
) {
  const t = Date.parse(lastSuccessAt);
  const has = Number.isFinite(t);
  const age = has ? freshness(lastSuccessAt, now, staleAfterMs) : null;
  // `label` is the full sentence; `short` fits a phone's top bar.
  if (!has) {
    if (lastError) {
      return {
        state: "failed",
        label: `Could not load: ${lastError}`,
        short: "Failed",
      };
    }
    return { state: "loading", label: "Loading…", short: "Loading" };
  }
  if (refreshing) {
    return {
      state: "refreshing",
      label: `Refreshing… (data from ${age.label})`,
      short: "Refreshing",
    };
  }
  if (lastError) {
    return {
      state: "failed",
      label: `Refresh failed; showing data from ${age.label}`,
      short: "Failed",
    };
  }
  if (age.stale) {
    return {
      state: "stale",
      label: `Stale: updated ${age.label}`,
      short: `Stale ${age.label}`,
    };
  }
  return { state: "fresh", label: `Updated ${age.label}`, short: age.label };
}
