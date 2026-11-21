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
