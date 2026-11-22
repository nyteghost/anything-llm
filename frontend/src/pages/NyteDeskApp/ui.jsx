// Small presentational pieces shared by the NyteDesk dashboard. Colours follow
// the approved dark concept (zinc surfaces, indigo accent) with light-theme
// equivalents from AnythingLLM's theme.
import { displayState } from "@/utils/nytedesk/taskState";

export const surface =
  "rounded-xl border border-white/10 light:border-slate-200 bg-zinc-900 light:bg-white";
export const muted = "text-zinc-400 light:text-slate-500";
export const heading =
  "text-sm font-semibold text-white light:text-slate-900 tracking-tight";

const TONES = {
  neutral:
    "bg-zinc-700/60 text-zinc-200 light:bg-slate-100 light:text-slate-700",
  info: "bg-sky-500/15 text-sky-300 light:bg-sky-100 light:text-sky-800",
  active:
    "bg-indigo-500/20 text-indigo-300 light:bg-indigo-100 light:text-indigo-800",
  success:
    "bg-emerald-500/15 text-emerald-300 light:bg-emerald-100 light:text-emerald-800",
  warning:
    "bg-amber-500/15 text-amber-300 light:bg-amber-100 light:text-amber-900",
  danger: "bg-red-500/15 text-red-300 light:bg-red-100 light:text-red-800",
};

export function Badge({ tone = "neutral", children, title }) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap ${TONES[tone] || TONES.neutral}`}
    >
      {children}
    </span>
  );
}

export function StateBadge({ status, action }) {
  const s = displayState(status, action);
  return (
    <Badge tone={s.tone} title={`Backend state: ${String(status)}`}>
      {s.label}
    </Badge>
  );
}

export function Card({
  title,
  action,
  children,
  className = "",
  as = "section",
  labelledBy,
}) {
  const Tag = as;
  return (
    <Tag
      aria-labelledby={labelledBy}
      className={`${surface} p-4 flex flex-col gap-3 min-w-0 ${className}`}
    >
      {(title || action) && (
        <div className="flex items-center justify-between gap-2">
          {title && (
            <h2 id={labelledBy} className={heading}>
              {title}
            </h2>
          )}
          {action}
        </div>
      )}
      {children}
    </Tag>
  );
}

/** A horizontal bar for a measured percentage; nothing is drawn without data. */
export function Meter({ percent, label }) {
  if (typeof percent !== "number") return null;
  const value = Math.min(Math.max(percent, 0), 100);
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value)}
      className="h-1.5 w-full rounded-full bg-white/10 light:bg-slate-200 overflow-hidden"
    >
      <div
        className="h-full rounded-full bg-indigo-500"
        style={{ width: `${value}%` }}
      />
    </div>
  );
}

export function Unavailable({ reason }) {
  return (
    <span className={`text-xs ${muted}`} title={reason}>
      Unavailable
    </span>
  );
}

export function formatBytes(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "—";
  const gib = bytes / 2 ** 30;
  return gib >= 1
    ? `${gib.toFixed(1)} GB`
    : `${Math.round(bytes / 2 ** 20)} MB`;
}

/** "3m ago" from an ISO time and a `now` passed in (never read during render). */
export function timeAgo(iso, now) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t) || typeof now !== "number") return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function EngineStatus({ engine }) {
  if (!engine?.endpoint) return <Badge>Not configured</Badge>;
  const status = engine.lastCheck?.status;
  if (!status) return <Badge>Not checked</Badge>;
  if (status === "external") return <Badge tone="success">Reachable</Badge>;
  return <Badge tone="danger">Unreachable</Badge>;
}

export const ENGINE_NAMES = {
  ollama: "Ollama",
  strata: "Strata",
  polystrata: "PolyStrata",
};
